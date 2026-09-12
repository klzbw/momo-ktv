/**
 * 网盘串流代理 - Gbox AList 版本
 *
 * 提供 /api/cloud/stream/:file_id 和 /api/cloud/stream-path/:accountId/* 端点
 * 自动获取网盘直链并返回 302 重定向（不占 NAS 带宽）
 *
 * 修复历史：
 *   - 原硬编码 Alist token 会过期（401），改为启动时动态登录 + 自动刷新
 *   - 原硬编码 alistBasePath 写死 /🥝115网盘/115，改为可通过环境变量配置
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

// 直链内存缓存：filePath -> { url, expiresAt }
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
      console.log('[Streamer] Getting direct URL for:', fullPath);

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
                console.log('[Streamer] Got direct URL:', result.data.raw_url.substring(0, 100) + '...');
                resolve(result.data.raw_url);
              } else if (result.code === 401) {
                // token 过期，强制刷新后下次重试
                this.alistToken = null;
                this._alistTokenExpiry = 0;
                console.warn('[Streamer] AList token 失效(401)，已标记为待刷新');
                resolve(null);
              } else {
                console.error('[Streamer] Failed to get direct URL:', result.message || 'unknown');
                resolve(null);
              }
            } catch (e) {
              console.error('[Streamer] Parse error:', e.message);
              resolve(null);
            }
          });
        });
        req.on('error', (e) => {
          console.error('[Streamer] Request error:', e.message);
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
      console.error('[Streamer] Error getting direct URL:', error.message);
      return null;
    }
  }

  /**
   * 获取文件直链（带缓存）
   */
  async getDirectUrl(filePath) {
    const cacheKey = filePath;
    const cached = urlCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      console.log('[Streamer] Using cached URL for:', filePath);
      return cached.url;
    }

    const directUrl = await this.getAlistDirectUrl(filePath);

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
   * 用于 /api/cloud/stream-path/:accountId/* 端点
   */
  async handleStreamByPath(req, res) {
    try {
      const accountId = req.params.accountId;
      const filePath = req.params[0] || '';

      console.log('[Streamer] handleStreamByPath:', accountId, filePath);

      if (!filePath) {
        res.status(400).json({ error: 'File path is required' });
        return;
      }

      const directUrl = await this.getDirectUrl(filePath);

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
