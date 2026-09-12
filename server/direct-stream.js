/**
 * 网盘直连串流 - 通过 pan115 driver 获取 115 CDN 直链，返回 302 重定向
 *
 * 为什么用 pan115 driver 而不是 AList /d/ 端点？
 *   1. AList(小雅定制版v1.0.0)的 115 Cloud 驱动返回的 raw_url 签名无效，
 *      访问 115 CDN 返回 403 invalid signature，导致 VLC/tvOS 播放失败。
 *   2. pan115 driver 使用 115 官方加密API(proapi.115.com/app/chrome/downurl)
 *      获取直链，签名正确，实测返回 206 Partial Content + MKV 数据。
 *   3. pan115 driver 内置限流(5 req/s)和直链缓存(按URL中t参数动态TTL)，
 *      不会频繁调用 115 API，有效防止风控。
 *
 * 为什么不直接代理媒体数据？
 *   硬性要求：视频不占 NAS 带宽和容量。本端点只做一次轻量 API 调用获取直链，
 *   然后 302 重定向，媒体数据直接从 115 CDN 到客户端，NAS 零转发。
 *
 * 数据流：客户端 → /api/direct-stream (302) → 115 CDN 直链
 *
 * UA 透传（关键）：115 CDN 下载 URL 的签名与调用 downurl API 时的 User-Agent 绑定。
 * 必须用客户端（VLC/tvOS/浏览器）的 UA 调用 API，生成的 URL 客户端才能下载，
 * 否则 CDN 返回 403 invalid signature。这里把 req.get('User-Agent') 透传给驱动。
 *
 * 修复历史：
 *   - 原硬编码 ALIST_TOKEN 会过期(401)，改为动态登录 Alist + 自动刷新
 */

const express = require('express');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const router = express.Router();

// 延迟加载依赖（避免循环引用）
let _db = null;
let _Pan115Driver = null;
let _driverCache = null; // 单例 driver 实例

// AList 配置（仅作 fallback）
const ALIST_BASE_URL = process.env.ALIST_URL || process.env.ALIST_BASE_URL || 'http://localhost:5234';
const ALIST_BASE_PATH = process.env.ALIST_BASE_PATH || '/🥝115网盘/115';
// 不再硬编码 token，启动后由 _alistLogin() 动态获取
let _alistToken = null;
let _alistTokenExpiry = 0;

/**
 * 初始化：传入 db 实例
 */
function init(db) {
  _db = db;
  _Pan115Driver = require('./cloud-drive/drivers/pan115');

  // 启动时异步登录 Alist（fallback 用）
  _alistLogin().catch(e =>
    console.warn('[DirectStream] AList 初始登录失败，fallback 暂不可用:', e.message)
  );

  return router;
}

/**
 * 登录 Alist 获取 token（参考 share-import.js / streamer.js 的成熟实现）
 */
async function _alistLogin(maxRetries = 5) {
  const password = process.env.ALIST_ADMIN_PASSWORD || 'admin123';
  const body = JSON.stringify({ username: 'admin', password });

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await new Promise((resolve, reject) => {
        const req = http.request(ALIST_BASE_URL + '/api/auth/login', {
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
        _alistToken = result.token;
        _alistTokenExpiry = Date.now() + 47 * 3600 * 1000;
        console.log('[DirectStream] AList 登录成功');
        return _alistToken;
      }

      if (result.message && result.message.includes('Loading storage')) {
        console.log(`[DirectStream] AList 正在加载存储，等待 5 秒后重试 (${attempt + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      throw new Error('Alist 登录失败: ' + result.message);
    } catch (e) {
      if (attempt < maxRetries - 1 && (e.message.includes('timeout') || e.message.includes('ECONNREFUSED'))) {
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      throw e;
    }
  }
  throw new Error('Alist 登录失败：超过最大重试次数');
}

async function _getAlistToken() {
  if (_alistToken && Date.now() < _alistTokenExpiry) {
    return _alistToken;
  }
  return await _alistLogin();
}

/**
 * 获取活跃的 115 账号
 */
function getActiveAccount() {
  if (!_db) return null;
  return _db.prepare("SELECT * FROM cloud_accounts WHERE driver='pan115' AND status='active' ORDER BY id DESC LIMIT 1").get();
}

/**
 * 获取或创建 pan115 driver 单例
 */
function getDriver() {
  if (_driverCache) return _driverCache;
  const account = getActiveAccount();
  if (!account) return null;
  if (!_Pan115Driver) {
    _Pan115Driver = require('./cloud-drive/drivers/pan115');
  }
  _driverCache = new _Pan115Driver(account);
  return _driverCache;
}

/**
 * 重置 driver 缓存（账号更新时调用）
 */
function resetDriverCache() {
  _driverCache = null;
}

/**
 * Fallback: 通过 AList /api/fs/get 获取直链
 */
async function getDirectUrlFromAlist(filePath) {
  let token;
  try {
    token = await _getAlistToken();
  } catch (e) {
    console.warn('[DirectStream] 获取 AList token 失败:', e.message);
    return null;
  }

  return new Promise((resolve) => {
    const fullPath = ALIST_BASE_PATH.replace(/\/+$/, '') + '/' + filePath.replace(/^\/+/, '');
    const postData = JSON.stringify({ path: fullPath, password: '' });
    const url = new URL(ALIST_BASE_URL + '/api/fs/get');
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const req = client.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Authorization': token,
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          if (r.code === 200 && r.data && r.data.raw_url) {
            resolve(r.data.raw_url);
          } else {
            resolve(null);
          }
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(postData);
    req.end();
  });
}

/**
 * 主处理：获取直链并 302 重定向
 */
router.get('/*', async (req, res) => {
  try {
    let filePath = req.params[0] || '';
    try { filePath = decodeURIComponent(filePath); } catch (e) { /* 已解码 */ }
    console.log('[DirectStream] 请求:', filePath);

    if (!filePath) {
      return res.status(400).json({ error: 'File path is required' });
    }

    let directUrl = null;
    let source = 'pan115';

    // 方案1: pan115 driver 获取直链（首选，签名有效）
    const clientUA = req.get('User-Agent') || '';
    try {
      const driver = getDriver();
      if (driver) {
        const result = await driver.getDownloadUrlByPath(filePath, clientUA);
        if (result && result.url) {
          directUrl = result.url;
          console.log('[DirectStream] pan115直链获取成功 (UA:', clientUA.substring(0, 40) + ')');
        }
      } else {
        console.warn('[DirectStream] 无活跃115账号，跳过pan115');
      }
    } catch (e) {
      console.warn('[DirectStream] pan115获取直链失败:', e.message);
    }

    // 方案2: AList fallback（签名可能无效，但保留兜底）
    if (!directUrl) {
      source = 'alist';
      try {
        directUrl = await getDirectUrlFromAlist(filePath);
        if (directUrl) console.log('[DirectStream] AList直链获取成功(fallback)');
      } catch (e) {
        console.warn('[DirectStream] AList fallback失败:', e.message);
      }
    }

    if (!directUrl) {
      console.error('[DirectStream] 所有方案均失败:', filePath);
      return res.status(502).json({ error: 'Failed to get direct URL from 115' });
    }

    console.log('[DirectStream] 302 → 115 CDN (来源:' + source + '):', directUrl.substring(0, 80) + '...');
    res.redirect(302, directUrl);

  } catch (error) {
    console.error('[DirectStream] 处理错误:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

module.exports = { router, init, resetDriverCache };
