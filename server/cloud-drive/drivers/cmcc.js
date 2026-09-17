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
  // encodeURIComponent（与 AList Go 实现对齐：~ 编码为 %7E）
  let encoded = encodeURIComponent(body);
  encoded = encoded.replace(/~/g, '%7E');
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
    // base.js 构造函数设置了 this.refreshToken = account.refresh_token（实例属性），
    // 会覆盖本类原型上的 refreshToken() 方法，必须删除实例属性以暴露原型方法。
    delete this.refreshToken;
    // Authorization token（Basic 后面的部分）
    this.authorization = account.access_token || '';
    // 从 token 解析账号
    this.account2 = '';
    this.personalCloudHost = '';
    this._parseAuthorization();

    // 缓存
    this._cache = {
      files: new Map(),      // path -> {items, expireAt}
      urls: new Map(),       // fileId|ua -> {url, expireAt}
      fidPaths: new Map(),   // dir path -> fileId
      filePathFids: new Map(), // file path -> fileId (P4: 避免播放时重新列目录)
    };
    // P4: 文件路径->fid 持久化缓存文件路径
    this._fidCacheFile = null;
    this._cacheTTL = 30 * 60 * 1000; // 30 分钟（移动云盘曲库不常变，延长目录列表缓存）
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

    // P4: 填充文件路径 -> fid 映射（播放时直接查映射，不重新列目录）
    for (const item of allItems) {
      if (!item.isDir) {
        this._setCache('filePathFids', item.path, item.fileId, 24 * 60 * 60 * 1000);
      }
    }
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

    // P4: 优先查文件路径 -> fid 缓存，命中则直接取直链，不重新列目录
    const cachedFid = this._getCache('filePathFids', filePath);
    if (cachedFid) {
      return this.getDownloadUrl(cachedFid);
    }

    const dir = filePath.substring(0, filePath.lastIndexOf('/')) || '/';
    const fileName = filePath.substring(filePath.lastIndexOf('/') + 1);

    const files = await this.listFiles(dir);
    const file = files.find((f) => f.name === fileName);
    if (!file) {
      throw new Error(`移动云盘文件不存在: ${filePath}`);
    }
    // listFiles 已填充 filePathFids，这里兜底再存一次
    this._setCache('filePathFids', filePath, file.fileId, 24 * 60 * 60 * 1000);
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
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Token 刷新（移植自 AList 139 驱动 refreshToken）
   * - 有效期 > 15 天：不刷新
   * - 已过期：报错，需重新登录
   * - 否则：POST aas.caiyun.feixin.10086.cn/tellin/authTokenRefresh.do 刷新
   */
  async refreshToken() {
    try {
      const raw = this.authorization.replace(/^Basic\s+/i, '').trim();
      const decoded = Buffer.from(raw, 'base64').toString('utf8');
      const parts = decoded.split(':');
      if (parts.length < 3) throw new Error('authorization 格式无效');
      const account = parts[1];
      const tokenFields = parts[2].split('|');
      if (tokenFields.length < 4) throw new Error('authorization token 字段不足');
      const expiration = parseInt(tokenFields[3], 10);
      const now = Date.now();
      const remainMs = expiration - now;
      if (remainMs > 15 * 24 * 3600 * 1000) {
        return { accessToken: this.authorization, expiresAt: new Date(expiration), skipped: true };
      }
      if (remainMs < 0) {
        throw new Error('移动云盘 Authorization 已过期，请重新登录获取 Token');
      }
      // 调用刷新端点
      const xmlBody = `<root><token>${parts[2]}</token><account>${account}</account><clienttype>656</clienttype></root>`;
      const res = await this._httpXml('POST',
        'https://aas.caiyun.feixin.10086.cn:443/tellin/authTokenRefresh.do', xmlBody);
      const match = res.match(/<token>([^<]+)<\/token>/);
      const returnMatch = res.match(/<return>([^<]+)<\/return>/);
      if (returnMatch && returnMatch[1] !== '0') {
        throw new Error('移动云盘 Token 刷新失败: ' + (res.match(/<desc>([^<]+)<\/desc>/)?.[1] || returnMatch[1]));
      }
      if (!match) throw new Error('移动云盘 Token 刷新响应无 token: ' + res.slice(0, 200));
      const newToken = match[1];
      const newAuth = Buffer.from(`${parts[0]}:${account}:${newToken}`).toString('base64');
      this.authorization = newAuth;
      this._parseAuthorization();
      console.log('[CMCC] Token 刷新成功');
      return { accessToken: newAuth, expiresAt: new Date(now + 30 * 24 * 3600 * 1000) };
    } catch (e) {
      console.warn('[CMCC] refreshToken 失败:', e.message);
      throw e;
    }
  }

  /**
   * XML 请求（用于 Token 刷新）
   */
  async _httpXml(method, urlStr, bodyStr) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(urlStr);
      const opts = {
        method,
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        headers: {
          'User-Agent': CMCC_UA,
          'Content-Type': 'application/xml',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      };
      const req = https.request(opts, (res) => {
        let chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error', reject);
      req.setTimeout(20000, () => req.destroy(new Error('CMCC XML 请求超时')));
      req.write(bodyStr);
      req.end();
    });
  }

  // ==================== P4: 冷启动优化：目录预加载 & fid 映射持久化 ====================

  /**
   * 递归预加载所有目录列表，填充 filePathFids 映射。
   * 在账号启用时/容器启动后后台调用，避免首次播放时冷启动列目录慢。
   * @param {number} [maxDepth=10] - 最大递归深度
   * @returns {Promise<{dirs: number, files: number}>}
   */
  async preloadAll(maxDepth = 10) {
    const stats = { dirs: 0, files: 0 };
    const visited = new Set();

    const walk = async (dirPath, depth) => {
      if (depth > maxDepth) return;
      if (visited.has(dirPath)) return;
      visited.add(dirPath);

      let items;
      try {
        items = await this.listFiles(dirPath);
      } catch (e) {
        console.warn('[CMCC preload] 列目录失败 ' + dirPath + ': ' + e.message);
        return;
      }
      stats.dirs++;

      for (const item of items) {
        if (item.isDir) {
          await walk(item.path, depth + 1);
        } else {
          stats.files++;
        }
      }
    };

    console.log('[CMCC preload] 开始预加载目录列表...');
    const startTime = Date.now();
    await walk('/', 0);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('[CMCC preload] 完成: 目录=' + stats.dirs + ' 文件=' + stats.files + ' 耗时=' + elapsed + 's');

    // 持久化 fid 映射
    try {
      this._saveFidCache();
    } catch (e) {
      console.warn('[CMCC preload] 持久化 fid 缓存失败:', e.message);
    }

    return stats;
  }

  /**
   * 设置持久化缓存文件路径（由 manager 调用，传入 data 目录）
   */
  setFidCacheFile(dataDir) {
    const accountId = this.account ? this.account.id : 'unknown';
    this._fidCacheFile = require('path').join(dataDir, 'cmcc-fid-cache-' + accountId + '.json');
    // 启动时尝试加载已有缓存
    this._loadFidCache();
  }

  /**
   * 从磁盘加载 filePathFids 缓存
   */
  _loadFidCache() {
    if (!this._fidCacheFile || !fs.existsSync(this._fidCacheFile)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this._fidCacheFile, 'utf8'));
      const ttl = 24 * 60 * 60 * 1000;
      let count = 0;
      for (const [filePath, fid] of Object.entries(data.mappings || {})) {
        this._setCache('filePathFids', filePath, fid, ttl);
        count++;
      }
      // 同时恢复目录路径 -> fid 映射
      for (const [dirPath, fid] of Object.entries(data.dirFids || {})) {
        this._setCache('fidPaths', dirPath, fid, ttl);
      }
      console.log('[CMCC fid-cache] 从磁盘加载 ' + count + ' 条文件路径映射');
    } catch (e) {
      console.warn('[CMCC fid-cache] 加载失败:', e.message);
    }
  }

  /**
   * 保存 filePathFids 缓存到磁盘
   */
  _saveFidCache() {
    if (!this._fidCacheFile) return;
    const mappings = {};
    const dirFids = {};
    const now = Date.now();
    for (const [key, entry] of this._cache.filePathFids.entries()) {
      if (entry.expireAt > now) mappings[key] = entry.value;
    }
    for (const [key, entry] of this._cache.fidPaths.entries()) {
      if (entry.expireAt > now) dirFids[key] = entry.value;
    }
    const data = { savedAt: new Date().toISOString(), mappings, dirFids };
    fs.writeFileSync(this._fidCacheFile, JSON.stringify(data), 'utf8');
    console.log('[CMCC fid-cache] 保存 ' + Object.keys(mappings).length + ' 条文件映射到 ' + this._fidCacheFile);
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
