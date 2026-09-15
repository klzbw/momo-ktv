/**
 * 网盘直连串流 - 多网盘版
 *
 * 支持网盘：115网盘(pan115)、夸克网盘(quark)、移动云盘(cmcc)
 *
 * 工作原理：
 *   1. 根据请求路径或 ?driver= 参数选择对应网盘驱动
 *   2. 调用 driver.getDownloadUrlByPath(filePath, clientUA) 获取 CDN 直链
 *   3. 302 重定向到 CDN，媒体数据直接从 CDN 到客户端，NAS 零转发
 *
 * 为什么用驱动而不是 AList /d/ 端点？
 *   1. AList 的 115 Cloud 驱动返回的 raw_url 签名可能无效（403 invalid signature）
 *   2. 各网盘驱动直接用官方 API 获取直链，签名正确
 *   3. 直链短期内存缓存（TTL 15 分钟），同一首歌重复播放不重复调 API，防止风控
 *
 * 数据流：客户端 → /api/direct-stream (302) → 网盘 CDN 直链
 *
 * UA 透传（关键）：部分网盘（如115）CDN URL 的签名与调用 API 时的 User-Agent 绑定。
 * 必须用客户端（浏览器/VLC）的 UA 调用 API，生成的 URL 客户端才能下载。
 * 这里把 req.get('User-Agent') 透传给驱动。
 *
 * 路由用法：
 *   /api/direct-stream/<filePath>           — 自动选择驱动（优先 pan115，再尝试其他活跃账号）
 *   /api/direct-stream/<filePath>?driver=quark  — 指定夸克网盘
 *   /api/direct-stream/<filePath>?driver=cmcc   — 指定移动云盘
 *   /api/direct-stream/<filePath>?driver=pan115  — 指定115网盘
 */

const express = require('express');
const path = require('path');
const router = express.Router();

// 延迟加载依赖（避免循环引用）
let _db = null;
let _driverCache = new Map(); // accountId -> driver 实例

// ==================== 直链短期缓存（P1 风控优化） ====================
// 背景：direct-stream 每次播放都调用 driver.getDownloadUrlByPath() -> 网盘 API 获取直链，
// 同一首歌重复播放（如暂停/继续、切歌后切回、多端同时播放）会重复触发网盘 API 调用，
// 增加风控风险和播放延迟。115 等网盘的 CDN 直链签名与 User-Agent 绑定，因此缓存 key
// 必须包含 UA（做 hash 以控制长度）。
//
// 策略：
//   - TTL 默认 15 分钟（115 直链通常有效期远长于此，15 分钟是安全保守值）
//   - 最多 2000 条，超出时清理过期条目；仍超出则删除最旧的条目
//   - 同一 key 的并发请求共享同一个 in-flight Promise，避免重复调 API
const DIRECT_URL_CACHE_TTL_MS = (Number(process.env.DIRECT_STREAM_CACHE_TTL_SECONDS) || 900) * 1000;
const DIRECT_URL_CACHE_MAX = Number(process.env.DIRECT_STREAM_CACHE_MAX) || 2000;
const _directUrlCache = new Map(); // key -> { url, expireAt }
const _directUrlInflight = new Map(); // key -> Promise<{url, source}>

function _cacheKey(accountId, filePath, clientUA) {
  // 对 UA 做简单 hash（djb2），避免长 UA 导致 key 过大
  let h = 5381;
  const ua = clientUA || '';
  for (let i = 0; i < ua.length; i++) h = ((h << 5) + h + ua.charCodeAt(i)) | 0;
  return accountId + ':' + filePath + ':' + h;
}

function _cacheGet(key) {
  const entry = _directUrlCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expireAt) {
    _directUrlCache.delete(key);
    return null;
  }
  return entry.url;
}

function _cacheSet(key, url) {
  // 超出上限时先清理过期条目
  if (_directUrlCache.size >= DIRECT_URL_CACHE_MAX) {
    const now = Date.now();
    for (const [k, v] of _directUrlCache) {
      if (now > v.expireAt) _directUrlCache.delete(k);
    }
    // 仍超出则删除最旧的 10%
    if (_directUrlCache.size >= DIRECT_URL_CACHE_MAX) {
      const toDelete = Math.ceil(DIRECT_URL_CACHE_MAX * 0.1);
      let count = 0;
      for (const k of _directUrlCache.keys()) {
        _directUrlCache.delete(k);
        if (++count >= toDelete) break;
      }
    }
  }
  _directUrlCache.set(key, { url, expireAt: Date.now() + DIRECT_URL_CACHE_TTL_MS });
}

// 驱动类映射（与 manager.js 的 DRIVERS 保持一致）
const DRIVER_CLASSES = {
  pan115: () => require('./cloud-drive/drivers/pan115'),
  quark: () => require('./cloud-drive/drivers/quark'),
  cmcc: () => require('./cloud-drive/drivers/cmcc'),
};

/**
 * 初始化：传入 db 实例
 */
function init(db) {
  _db = db;
  return router;
}

/**
 * 获取活跃的网盘账号列表
 * @param {string} [driverFilter] - 指定驱动类型筛选，不传则返回所有
 */
function getActiveAccounts(driverFilter) {
  if (!_db) return [];
  if (driverFilter) {
    return _db.prepare(
      "SELECT * FROM cloud_accounts WHERE driver=? AND status='active' ORDER BY id DESC"
    ).all(driverFilter);
  }
  return _db.prepare(
    "SELECT * FROM cloud_accounts WHERE status='active' ORDER BY id DESC"
  ).all();
}

/**
 * 获取或创建指定账号的 driver 实例（按 accountId 缓存）
 */
function getDriverForAccount(account) {
  if (_driverCache.has(account.id)) return _driverCache.get(account.id);
  const loader = DRIVER_CLASSES[account.driver];
  if (!loader) {
    console.warn('[DirectStream] 未知驱动类型:', account.driver);
    return null;
  }
  const DriverClass = loader();
  const instance = new DriverClass(account);
  _driverCache.set(account.id, instance);
  return instance;
}

/**
 * 重置 driver 缓存（账号更新时调用）
 */
function resetDriverCache() {
  _driverCache.clear();
}

// AList 配置（仅作 fallback，目前只对 115 路径有效）
const ALIST_BASE_URL = process.env.ALIST_BASE_URL || 'http://localhost:5345';
const ALIST_BASE_PATH = process.env.ALIST_BASE_PATH || '/🥝115网盘/115';
const ALIST_TOKEN = process.env.ALIST_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VybmFtZSI6ImFkbWluIiwicHdkX3RzIjoxNzg4NjIzNDA4LCJleHAiOjE4MDU5MDM5ODQsIm5iZiI6MTc4ODYyMzk4NCwiaWF0IjoxNzg4NjIzOTg0fQ.5XzN8q2T1jEaO8yoV8eTj6gZzBmDUtr1ijUuM48QD9w';

/**
 * Fallback: 通过 AList /api/fs/get 获取直链（仅 115 路径）
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
 * 尝试用指定账号的驱动获取直链
 * @returns {Promise<{url: string, source: string} | null>}
 */
async function tryDriver(account, filePath, clientUA) {
  try {
    const driver = getDriverForAccount(account);
    if (!driver) return null;
    const result = await driver.getDownloadUrlByPath(filePath, clientUA);
    if (result && result.url) {
      return { url: result.url, source: account.driver };
    }
  } catch (e) {
    console.warn('[DirectStream] 驱动 ' + account.driver + ' 失败:', e.message);
  }
  return null;
}

/**
 * 主处理：获取直链并 302 重定向
 */
router.get('/*', async (req, res) => {
  try {
    let filePath = req.params[0] || '';
    try { filePath = decodeURIComponent(filePath); } catch (e) { /* 已解码 */ }
    const driverFilter = req.query.driver || null;
    console.log('[DirectStream] 请求:', filePath, 'driver:', driverFilter || 'auto');

    if (!filePath) {
      return res.status(400).json({ error: 'File path is required' });
    }

    let directUrl = null;
    let source = null;

    // 收集要尝试的账号列表
    let accounts;
    if (driverFilter) {
      accounts = getActiveAccounts(driverFilter);
      if (accounts.length === 0) {
        console.warn('[DirectStream] 指定驱动 ' + driverFilter + ' 无活跃账号');
      }
    } else {
      // 自动模式：优先 pan115（向后兼容），然后其他活跃账号
      accounts = getActiveAccounts();
      accounts.sort((a, b) => {
        if (a.driver === 'pan115') return -1;
        if (b.driver === 'pan115') return 1;
        return a.id - b.id;
      });
    }

    // 关键：透传客户端 UA——部分网盘（115）CDN URL 签名与 UA 绑定
    const clientUA = req.get('User-Agent') || '';

    // 逐个尝试驱动
    for (const account of accounts) {
      const result = await tryDriver(account, filePath, clientUA);
      if (result) {
        directUrl = result.url;
        source = result.source;
        console.log('[DirectStream] ' + source + ' 直链获取成功 (UA:', clientUA.substring(0, 40) + ')');
        break;
      }
    }

    // Fallback: AList（仅 115 路径有效）
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
      return res.status(502).json({ error: 'Failed to get direct URL from cloud drive', path: filePath });
    }

    // 302 重定向到 CDN 直链
    console.log('[DirectStream] 302 → CDN (来源:' + source + '):', directUrl.substring(0, 80) + '...');
    res.redirect(302, directUrl);

  } catch (error) {
    console.error('[DirectStream] 处理错误:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

module.exports = { router, init, resetDriverCache, clearDirectUrlCache };
