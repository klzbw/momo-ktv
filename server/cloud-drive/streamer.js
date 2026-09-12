/**
 * 网盘串流代理
 *
 * 提供 /api/cloud/stream-path/:accountId/* 与 /api/cloud/direct/:accountId/* 端点。
 *
 * 核心策略（NAS 零转发）：
 *   1. 优先按 accountId 找到对应网盘驱动实例（115/夸克/阿里云/百度/迅雷/移动），
 *      调用驱动的 getDownloadUrlByPath(filePath, clientUA) 获取网盘 CDN 直链，302 重定向。
 *      媒体数据从网盘 CDN 直连客户端，不经过 NAS。
 *   2. 驱动取直链失败时，回退到内置 AList（getAlistDirectUrl）作为兜底。
 *
 * UA 透传：网盘 CDN 直链签名常与请求时的 User-Agent 绑定，必须把客户端 UA
 *   （req.get('User-Agent')）透传给驱动，否则可能 403 invalid signature。
 *
 * 直链内存缓存：key = `${accountId}|${ua}|${filePath}`（含 UA，避免不同客户端 UA 串用导致 403）。
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

// 直链内存缓存：key -> { url, expiresAt }
const urlCache = new Map();
const CACHE_TTL = 25 * 60 * 1000; // 25分钟缓存

class CloudDriveStreamer {
  constructor(manager) {
    this.manager = manager;
    this.alistEnabled = true;
    this.alistUrl = process.env.ALIST_URL || 'http://localhost:5234';
    // 不再硬编码 token；启动后由 _alistLogin() 动态获取
    this.alistToken = null;
    this._alistTokenExpiry = 0;
    this.alistBasePath = process.env.ALIST_BASE_PATH || '/🥝115网盘/115';
    console.log('[Streamer] AList enabled:', this.alistEnabled);
    console.log('[Streamer] AList URL:', this.alistUrl);
    console.log('[Streamer] AList base path:', this.alistBasePath);

    // 启动时登录 Alist（异步，失败后重试逻辑在 _alistLogin 内）
    this._alistLogin().catch(e =>
      console.warn('[Streamer] AList 初始登录失败，后续请求时会重试:', e.message)
    );
  }

  /**
   * 登录 Alist 获取 token（参考 share-import.js 的成熟实现）
   * @param {number} maxRetries
   * @returns {Promise<string>} token
   */
  async _alistLogin(maxRetries = 5) {
    const password = process.env.ALIST_ADMIN_PASSWORD || 'admin123';
    const body = JSON.stringify({ username: 'admin', password });

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const result = await new Promise((resolve, reject) => {
          const req = http.request(this.alistUrl + '/api/auth/login', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
            },
            timeout: 10000,
          }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
              try {
                const r = JSON.parse(data);
                if (r.code === 200 && r.data && r.data.token) {
                  resolve({ success: true, token: r.data.token });
                } else {
                  resolve({ success: false, message: r.message || data });
                }
              } catch (e) {
                reject(e);
              }
            });
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error('Alist 登录超时')); });
          req.write(body);
          req.end();
        });

        if (result.success) {
          this.alistToken = result.token;
          // Alist token 默认有效期 48 小时，提前 1 小时刷新
          this._alistTokenExpiry = Date.now() + 47 * 3600 * 1000;
          console.log('[Streamer] AList 登录成功');
          return this.alistToken;
        }

        // Alist 还在加载存储，等待重试
        if (result.message && result.message.includes('Loading storage')) {
          console.log(`[Streamer] AList 正在加载存储，等待 5 秒后重试 (${attempt + 1}/${maxRetries})`);
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        throw new Error('Alist 登录失败: ' + result.message);
      } catch (e) {
        if (attempt < maxRetries - 1 && (e.message.includes('timeout') || e.message.includes('ECONNREFUSED'))) {
          console.log(`[Streamer] AList 登录异常，等待 3 秒后重试: ${e.message}`);
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
        throw e;
      }
    }
    throw new Error('Alist 登录失败：超过最大重试次数');
  }

  /**
   * 获取有效的 Alist token（过期自动刷新）
   */
  async _getAlistToken() {
    if (this.alistToken && Date.now() < this._alistTokenExpiry) {
      return this.alistToken;
    }
    return await this._alistLogin();
  }

  /**
   * 从 AList 获取文件直链
   */
  async getAlistDirectUrl(filePath) {
    try {
      const token = await this._getAlistToken();
      const fullPath = this.alistBasePath + '/' + filePath;
      console.log('[Streamer] Getting direct URL from AList:', fullPath);

      const postData = JSON.stringify({
        path: fullPath,
        password: ''
      });

      const url = new URL(this.alistUrl + '/api/fs/get');
      const isHttps = url.protocol === 'https:';
      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'Authorization': token
        },
        timeout: 30000
      };

      const client = isHttps ? https : http;

      return new Promise((resolve, reject) => {
        const req = client.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              const result = JSON.parse(data);
              if (result.code === 200 && result.data && result.data.raw_url) {
                console.log('[Streamer] Got AList direct URL:', result.data.raw_url.substring(0, 100) + '...');
                resolve(result.data.raw_url);
              } else if (result.code === 401) {
                // token 过期，强制刷新后下次重试
                this.alistToken = null;
                this._alistTokenExpiry = 0;
                console.warn('[Streamer] AList token 失效(401)，已标记为待刷新');
                resolve(null);
              } else {
                console.error('[Streamer] AList failed to get direct URL:', result.message || 'unknown');
                resolve(null);
              }
            } catch (e) {
              console.error('[Streamer] AList parse error:', e.message);
              resolve(null);
            }
          });
        });
        req.on('error', (e) => {
          console.error('[Streamer] AList request error:', e.message);
          resolve(null);
        });
        req.on('timeout', () => {
          req.destroy();
          resolve(null);
        });
        req.write(postData);
        req.end();
      });
    } catch (error) {
      console.error('[Streamer] AList error getting direct URL:', error.message);
      return null;
    }
  }

  /**
   * 通过网盘驱动实例获取直链（多驱动：115/quark/aliyun/baidu/xunlei/cmcc）
   * @param {number} accountId
   * @param {string} filePath
   * @param {string} clientUA - 客户端 UA，透传给驱动做签名绑定
   * @returns {Promise<string|null>}
   */
  async getDriverDirectUrl(accountId, filePath, clientUA) {
    try {
      const account = this.manager.getAccount(accountId);
      if (!account) {
        console.warn('[Streamer] 账号不存在:', accountId);
        return null;
      }
      const driver = this.manager.getDriver(account);
      if (typeof driver.getDownloadUrlByPath !== 'function') {
        console.warn(`[Streamer] 驱动 ${account.driver} 不支持 getDownloadUrlByPath，回退 AList`);
        return null;
      }
      const { url } = await driver.getDownloadUrlByPath(filePath, clientUA);
      console.log(`[Streamer] 驱动直链成功: account=${accountId} driver=${account.driver} path=${filePath}`);
      return url;
    } catch (e) {
      console.warn('[Streamer] 驱动取直链失败，将回退 AList:', e.message);
      return null;
    }
  }

  /**
   * 获取文件直链（带缓存，优先驱动直连，失败回退 AList）
   * @param {number} accountId
   * @param {string} filePath
   * @param {string} clientUA
   */
  async getDirectUrl(accountId, filePath, clientUA) {
    // 缓存 key 含 UA：不同客户端 UA 生成的签名不同，混用会 403
    const cacheKey = `${accountId}|${clientUA || 'none'}|${filePath}`;
    const cached = urlCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      console.log('[Streamer] Using cached URL for:', cacheKey);
      return cached.url;
    }

    // 1) 优先：对应网盘驱动直连（NAS 零转发）
    let directUrl = await this.getDriverDirectUrl(accountId, filePath, clientUA);

    // 2) 回退：内置 AList
    if (!directUrl) {
      directUrl = await this.getAlistDirectUrl(filePath);
    }

    if (directUrl) {
      urlCache.set(cacheKey, {
        url: directUrl,
        expiresAt: Date.now() + CACHE_TTL
      });
    }

    return directUrl;
  }

  /**
   * 通过文件路径串流（302 重定向到直链）
   * 用于 /api/cloud/stream-path/:accountId/* 与 /api/cloud/direct/:accountId/* 端点
   */
  async handleStreamByPath(req, res) {
    try {
      const accountId = parseInt(req.params.accountId, 10);
      let filePath = req.params[0] || '';
      try { filePath = decodeURIComponent(filePath); } catch (e) { /* 已是解码后 */ }

      console.log('[Streamer] handleStreamByPath:', accountId, filePath);

      if (!filePath) {
        res.status(400).json({ error: 'File path is required' });
        return;
      }

      // UA 透传：客户端 UA 传给驱动，保证 CDN 签名有效
      const clientUA = req.get('User-Agent') || '';
      const directUrl = await this.getDirectUrl(accountId, filePath, clientUA);

      if (!directUrl) {
        res.status(500).json({ error: 'Failed to get direct URL' });
        return;
      }

      console.log('[Streamer] Redirecting to:', directUrl.substring(0, 100) + '...');
      res.redirect(302, directUrl);

    } catch (error) {
      console.error('[Streamer] handleStreamByPath error:', error.message);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message });
      }
    }
  }

  /**
   * 通过文件 ID 串流
   * 用于 /api/cloud/stream/:file_id 端点
   */
  async handleStream(req, res) {
    try {
      const fileId = req.params.file_id;
      console.log('[Streamer] handleStream:', fileId);

      res.status(501).json({ error: 'Not implemented, use /api/cloud/stream-path/:accountId/* instead' });

    } catch (error) {
      console.error('[Streamer] handleStream error:', error.message);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message });
      }
    }
  }
}

module.exports = CloudDriveStreamer;
