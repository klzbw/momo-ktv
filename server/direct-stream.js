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
 */

const express = require('express');
const path = require('path');
const router = express.Router();

// 延迟加载依赖（避免循环引用）
let _db = null;
let _Pan115Driver = null;
let _driverCache = null; // 单例 driver 实例

/**
 * 初始化：传入 db 实例
 */
function init(db) {
  _db = db;
  _Pan115Driver = require('./cloud-drive/drivers/pan115');
  return router;
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

// AList 配置（仅作 fallback）
const ALIST_BASE_URL = process.env.ALIST_BASE_URL || 'http://localhost:5234';
const ALIST_BASE_PATH = process.env.ALIST_BASE_PATH || '/🥝115网盘/115';
const ALIST_TOKEN = process.env.ALIST_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VybmFtZSI6ImFkbWluIiwicHdkX3RzIjoxNzg4NjIzNDA4LCJleHAiOjE4MDU5MDM5ODQsIm5iZiI6MTc4ODYyMzk4NCwiaWF0IjoxNzg4NjIzOTg0fQ.5XzN8q2T1jEaO8yoV8eTj6gZzBmDUtr1ijUuM48QD9w';

/**
 * Fallback: 通过 AList /api/fs/get 获取直链
 */
function getDirectUrlFromAlist(filePath) {
  return new Promise((resolve) => {
    const http = require('http');
    const https = require('https');
    const { URL } = require('url');
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
        'Authorization': ALIST_TOKEN,
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
          } else { resolve(null); }
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
    try {
      const driver = getDriver();
      if (driver) {
        const result = await driver.getDownloadUrlByPath(filePath);
        if (result && result.url) {
          directUrl = result.url;
          console.log('[DirectStream] pan115直链获取成功');
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

    // 302 重定向到 115 CDN 直链
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
