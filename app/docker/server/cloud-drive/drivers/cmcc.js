/**
 * 中国移动云盘驱动 (cmcc / 和彩云 / 139Yun)
 *
 * 认证方式：Authorization Basic Token（从 AList 后台或浏览器获取）
 * Token 是 base64 编码，解码后格式: ?:account:token|?|?|expiration
 *
 * API 特点：
 * 1. API 域名动态获取（qryRoutePolicy 查询用户专属 personal cloud host）
 * 2. 每个请求需要 calSign 签名（encodeURIComponent→字符排序→base64→双重MD5）
 * 3. 直链不需要 cookie（和 115 一样，VLC 可直接播放 CDN）
 *
 * 参考：AList drivers/139 (Go) 移植为 Node.js
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const CloudDriveBase = require('./base');

// 路由查询固定域名
const ROUTE_URL = 'https://user-njs.yun.139.com/user/route/qryRoutePolicy';

// 移动云盘 Web UA
const CMCC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * 移动云盘请求签名算法（移植自 AList calSign）
 * 1. body = encodeURIComponent(jsonBody)
 * 2. 按 UTF-8 字节序排序字符
 * 3. base64 编码
 * 4. MD5(base64) + MD5(ts:randStr)
 * 5. 再 MD5 并转大写
 */
function calSign(body, ts, randStr) {
  // encodeURIComponent（与 JS 内置一致）
  const encoded = encodeURIComponent(body);
  // 按 code point 拆分，按 UTF-8 字节序排序（与 Go sort.Strings 对齐）
  const chars = Array.from(encoded);
  chars.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  const sorted = chars.join('');
  const b64 = Buffer.from(sorted, 'utf8').toString('base64');
  const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
  const combined = md5(b64) + md5(ts + ':' + randStr);
  return md5(combined).toUpperCase();
}

/** 生成 16 位随机字符串（字母数字） */
function randomString(len = 16) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[crypto.randomInt(chars.length)];
  return out;
}

/** 格式化时间为 Go 的 2006-01-02 15:04:05 格式 */
function formatTimestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
    `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

class CmccDriver extends CloudDriveBase {
  constructor(account) {
    super(account);
    // Authorization token（Basic 后面的部分）
    this.authorization = account.access_token || '';
    // 从 token 解析账号
    this.account2 = '';
    this.personalCloudHost = '';
    this._parseAuthorization();

    // 缓存
    this._cache = {
      files: new Map(),    // path -> {items, expireAt}
      urls: new Map(),     // fileId|ua -> {url, expireAt}
      fidPaths: new Map(), // path -> fileId
    };
    this._cacheTTL = 2 * 60 * 1000; // 2 分钟
    this._hostLock = null; // ensureHost 去重
  }

  // ==================== 认证解析 ====================

  _parseAuthorization() {
    try {
      // token 可能带 "Basic " 前缀，去掉
      let raw = this.authorization.replace(/^Basic\s+/i, '').trim();
      const decoded = Buffer.from(raw, 'base64').toString('utf8');
      const parts = decoded.split(':');
      if (parts.length >= 3) {
        this.account2 = parts[1];
      }
    } catch (e) {
      console.warn('[CMCC] authorization 解析失败:', e.message);
    }
  }

  // ==================== HTTP 工具 ====================

  /**
   * 通用 HTTPS JSON 请求
   */
  _httpJson(method, urlStr, { body, headers } = {}) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(urlStr);
      const lib = parsed.protocol === 'https:' ? https : http;
      const bodyStr = body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;

      const opts = {
        method,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers: {
          'User-Agent': CMCC_UA,
          'Accept': 'application/json, text/plain, */*',
          ...(headers || {}),
        },
      };
      if (bodyStr) {
        opts.headers['Content-Type'] = 'application/json';
        opts.headers['Content-Length'] = Buffer.byteLength(bodyStr);
      }

      const req = lib.request(opts, (res) => {
        let chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(raw); } catch (e) { /* 非 JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, body: json, raw });
        });
      });
      req.on('error', reject);
      req.setTimeout(20000, () => { req.destroy(new Error('CMCC 请求超时')); });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  /**
   * 构造移动云盘签名请求头
   */
  _buildSignedHeaders(bodyStr) {
    const ts = formatTimestamp();
    const randStr = randomString(16);
    const sign = calSign(bodyStr, ts, randStr);
    return {
      'Accept': 'application/json, text/plain, */*',
      'Authorization': 'Basic ' + this.authorization.replace(/^Basic\s+/i, '').trim(),
      'Caller': 'web',
      'Cms-Device': 'default',
      'Mcloud-Channel': '1000101',
      'Mcloud-Client': '10701',
      'Mcloud-Route': '001',
      'Mcloud-Sign': `${ts},${randStr},${sign}`,
      'Mcloud-Version': '7.14.0',
      'x-DeviceInfo': '||9|7.14.0|chrome|120.0.0.0|||windows 10||zh-CN|||',
      'x-huawei-channelSrc': '10000034',
      'x-inner-ntwk': '2',
      'x-m4c-caller': 'PC',
      'x-m4c-src': '10002',
      'x-SvcType': '1',
      'X-Yun-Api-Version': 'v1',
      'X-Yun-App-Channel': '10000034',
      'X-Yun-Channel-Source': '10000034',
      'X-Yun-Client-Info': '||13|7.14.0|chrome|120.0.0.0|||windows 10||zh-CN|||dW5kZWZpbmVk||',
      'X-Yun-Module-Type': '100',
      'X-Yun-Svc-Type': '1',
      'Origin': 'https://yun.139.com',
      'Referer': 'https://yun.139.com/w/',
    };
  }

  /**
   * 查询用户专属 personal cloud host（带缓存和去重）
   */
  async _ensureHost() {
    if (this.personalCloudHost) return this.personalCloudHost;
    if (this._hostLock) return this._hostLock;
    this._hostLock = this._queryRoute();
    try {
      this.personalCloudHost = await this._hostLock;
      return this.personalCloudHost;
    } finally {
      this._hostLock = null;
    }
  }

  async _queryRoute() {
    const body = {
      userInfo: { userType: 1, accountType: 1, accountName: this.account2 },
      modAddrType: 1,
    };
    const bodyStr = JSON.stringify(body);
    const headers = this._buildSignedHeaders(bodyStr);
    const res = await this._httpJson('POST', ROUTE_URL, { body: bodyStr, headers });
    if (!res.body || !res.body.success) {
      throw new Error('移动云盘路由查询失败: ' + (res.body?.message || res.raw?.slice(0, 200) || res.status));
    }
    const list = res.body.data?.routePolicyList || [];
    const personal = list.find((p) => p.modName === 'personal' && p.httpsUrl);
    if (!personal) {
      throw new Error('移动云盘未找到 personal 路由节点');
    }
    const host = personal.httpsUrl.replace(/\/+$/, '');
    console.log('[CMCC] personal cloud host:', host);
    return host;
  }

  /**
   * personal_new 类型的签名 POST 请求
   */
  async _personalPost(pathname, data) {
    const host = await this._ensureHost();
    const bodyStr = JSON.stringify(data);
    const headers = this._buildSignedHeaders(bodyStr);
    const url = host + pathname;
    const res = await this._httpJson('POST', url, { body: bodyStr, headers });
    if (!res.body) {
      throw new Error('移动云盘响应非 JSON: HTTP ' + res.status + ' ' + (res.raw || '').slice(0, 200));
    }
    if (res.body.success === false) {
      throw new Error('移动云盘 API 错误: ' + (res.body.message || JSON.stringify(res.body).slice(0, 200)));
    }
    return res.body;
  }

  // ==================== 缓存工具 ====================

  _getCache(type, key) {
    const cache = this._cache[type];
    if (!cache) return null;
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expireAt) { cache.delete(key); return null; }
    return entry.value;
  }

  _setCache(type, key, value, ttl = this._cacheTTL) {
    this._cache[type].set(key, { value, expireAt: Date.now() + ttl });
  }

  // ==================== 文件操作 ====================

  /**
   * 列出目录下的文件和子目录（游标分页，自动翻页）
   */
  async listFiles(remotePath) {
    remotePath = this._normalizePath(remotePath);
    const cached = this._getCache('files', remotePath);
    if (cached) return cached;

    const parentFileId = await this._pathToFileId(remotePath);
    const allItems = [];
    let pageCursor = '';

    do {
      const body = {
        imageThumbnailStyleList: ['Small', 'Large'],
        orderBy: 'updated_at',
        orderDirection: 'DESC',
        pageInfo: { pageCursor, pageSize: 100 },
        parentFileId,
      };
      const resp = await this._personalPost('/file/list', body);
      const items = resp.data?.items || [];
      for (const it of items) {
        allItems.push({
          fileId: it.fileId,
          name: it.name,
          path: this._joinPath(remotePath, it.name),
          isDir: it.type === 'folder',
          size: it.size || 0,
          modifiedAt: it.updatedAt ? new Date(it.updatedAt) : new Date(),
        });
      }
      pageCursor = resp.data?.nextPageCursor || '';
    } while (pageCursor);

    this._setCache('files', remotePath, allItems);
    return allItems;
  }

  /**
   * 路径转 fileId（逐层查找，根目录为 "/"）
   */
  async _pathToFileId(remotePath) {
    remotePath = this._normalizePath(remotePath);
    if (remotePath === '/' || remotePath === '') return '/';

    const cached = this._getCache('fidPaths', remotePath);
    if (cached) return cached;

    const segments = remotePath.split('/').filter(Boolean);
    let currentId = '/';
    let currentPath = '';

    for (const seg of segments) {
      currentPath = currentPath ? currentPath + '/' + seg : '/' + seg;
      const segCached = this._getCache('fidPaths', currentPath);
      if (segCached) {
        currentId = segCached;
        continue;
      }
      // 列出当前目录，找匹配的子目录
      const items = await this._listByParentId(currentId);
      const match = items.find((it) => it.type === 'folder' && it.name === seg);
      if (!match) {
        const names = items.filter((i) => i.type === 'folder').slice(0, 10).map((i) => i.name);
        throw new Error(`移动云盘目录不存在: ${currentPath}（缺少: ${seg}，同级目录: ${names.join(', ')}）`);
      }
      currentId = match.fileId;
      this._setCache('fidPaths', currentPath, currentId);
    }

    return currentId;
  }

  /**
   * 按 parentFileId 列目录（内部方法，返回原始 API 字段，带缓存）
   */
  async _listByParentId(parentFileId) {
    const cacheKey = 'pid:' + parentFileId;
    const cached = this._getCache('files', cacheKey);
    if (cached) return cached;

    const allItems = [];
    let pageCursor = '';
    do {
      const body = {
        imageThumbnailStyleList: ['Small', 'Large'],
        orderBy: 'updated_at',
        orderDirection: 'DESC',
        pageInfo: { pageCursor, pageSize: 100 },
        parentFileId,
      };
      const resp = await this._personalPost('/file/list', body);
      allItems.push(...(resp.data?.items || []));
      pageCursor = resp.data?.nextPageCursor || '';
    } while (pageCursor);

    this._setCache('files', cacheKey, allItems);
    return allItems;
  }

  /**
   * 获取文件下载直链
   * @param {string} fileId
   * @returns {Promise<{url: string}>}
   */
  async getDownloadUrl(fileId) {
    const cacheKey = fileId;
    const cached = this._getCache('urls', cacheKey);
    if (cached) return cached;

    const resp = await this._personalPost('/file/getDownloadUrl', { fileId });
    const url = resp.data?.cdnUrl || resp.data?.url;
    if (!url) {
      throw new Error('移动云盘未返回下载直链: ' + JSON.stringify(resp.data || {}).slice(0, 200));
    }
    const result = { url, expiresAt: new Date(Date.now() + 30 * 60 * 1000) };
    this._setCache('urls', cacheKey, result, 25 * 60 * 1000);
    return result;
  }

  /**
   * 按文件路径获取下载直链（streamer.js 调用的统一接口）
   * @param {string} filePath - 网盘内完整路径
   * @param {string} [clientUA] - 客户端 UA（移动云盘直链不绑定 UA，保留参数一致性）
   * @returns {Promise<{url: string}>}
   */
  async getDownloadUrlByPath(filePath, clientUA) {
    filePath = this._normalizePath(filePath);
    const dir = filePath.substring(0, filePath.lastIndexOf('/')) || '/';
    const fileName = filePath.substring(filePath.lastIndexOf('/') + 1);

    const files = await this.listFiles(dir);
    const file = files.find((f) => f.name === fileName);
    if (!file) {
      throw new Error(`移动云盘文件不存在: ${filePath}`);
    }
    return this.getDownloadUrl(file.fileId);
  }

  // ==================== 账号信息 ====================

  async getUserInfo() {
    // 用根目录列表测试连接（移动云盘没有简洁的用户信息端点，用路由+根目录验证）
    await this._ensureHost();
    const items = await this._listByParentId('/');
    return {
      nickname: this.account2 || '移动云盘用户',
      totalSize: 0,
      usedSize: 0,
      rootItemCount: items.length,
    };
  }

  async testConnection() {
    try {
      await this.getUserInfo();
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Token 刷新（简化版：移动云盘 token 有效期较长，过期提示重新添加）
   */
  async refreshToken() {
    // TODO: 完整实现 aas.caiyun.feixin.10086.cn/tellin/authTokenRefresh.do
    // 当前 token 通常有效期较长，过期后让用户重新在管理后台添加
    return { accessToken: this.authorization, expiresAt: new Date(Date.now() + 15 * 24 * 3600 * 1000) };
  }

  // ==================== 扫码登录（暂不支持，用 Token 输入） ====================

  async getQRCode() {
    throw new Error('移动云盘暂不支持扫码登录，请在 AList 后台获取 Authorization Token 后粘贴');
  }

  async checkQRStatus() {
    throw new Error('移动云盘暂不支持扫码登录');
  }
}

module.exports = CmccDriver;
