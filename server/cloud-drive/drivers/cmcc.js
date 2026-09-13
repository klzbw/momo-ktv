/**
 * 中国移动云盘驱动 (cmcc / 和彩云)
 *
 * 认证方式：Cookie 登录（从浏览器复制完整 Cookie 字符串粘贴）
 * 移动云盘 Web 端地址：https://yun.139.com/
 *
 * 注意：移动云盘开放平台 API 文档不公开，以下实现基于 Web 端抓包推断。
 * 列文件/获取直链等方法标注了 TODO，待实际抓包确认后完善。
 * 框架结构与 pan115/quark 一致，后续只需填充具体 API 调用。
 *
 * 参考：
 * - Web 端：https://yun.139.com/w/
 * - 开放平台：https://open.10086.cn/（需企业认证）
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const CloudDriveBase = require('./base');

// API 端点（基于 Web 端抓包，待验证）
const API_URLS = {
  // TODO: 确认实际 API 域名和路径
  listFiles: 'https://yun.139.com/api/open/file/list',
  getDownloadURL: 'https://yun.139.com/api/open/file/download',
  accountInfo: 'https://yun.139.com/api/open/user/info',
};

// User-Agent
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

class CmccDriver extends CloudDriveBase {
  constructor(account) {
    super(account);
    // Cookie 字符串
    this.cookie = account.access_token || '';
    this._userAgent = USER_AGENT;

    // 限流：每秒 3 个请求（移动云盘风控较严）
    this._rateLimit = {
      maxPerSecond: 3,
      timestamps: [],
    };

    // 缓存
    this._cache = {
      files: new Map(),
      urls: new Map(),
      pathIds: new Map(),
    };
    this._cacheTTL = 2 * 60 * 1000;
  }

  // ==================== 限流控制 ====================

  async _acquireRateLimit() {
    const now = Date.now();
    const windowStart = now - 1000;
    this._rateLimit.timestamps = this._rateLimit.timestamps.filter(t => t > windowStart);

    if (this._rateLimit.timestamps.length >= this._rateLimit.maxPerSecond) {
      const waitTime = this._rateLimit.timestamps[0] + 1000 - now;
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return this._acquireRateLimit();
    }

    this._rateLimit.timestamps.push(now);
  }

  // ==================== 缓存工具 ====================

  _getCache(type, key) {
    const cache = this._cache[type];
    if (!cache) return null;
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expireAt) {
      cache.delete(key);
      return null;
    }
    return entry.data;
  }

  _setCache(type, key, data, customTTL) {
    const cache = this._cache[type];
    if (!cache) return;
    const ttl = customTTL || this._cacheTTL;
    cache.set(key, {
      data,
      expireAt: Date.now() + ttl,
    });
  }

  // ==================== 内部 HTTP 工具 ====================

  async _request(method, url, options = {}) {
    await this._acquireRateLimit();

    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? https : http;

      const headers = {
        'User-Agent': this._userAgent,
        ...options.headers,
      };

      if (this.cookie) {
        headers['Cookie'] = this.cookie;
      }

      let bodyData = null;
      if (options.body !== undefined && options.body !== null) {
        if (typeof options.body === 'object') {
          bodyData = JSON.stringify(options.body);
          headers['Content-Type'] = 'application/json';
        } else {
          bodyData = String(options.body);
          headers['Content-Type'] = headers['Content-Type'] || 'application/x-www-form-urlencoded';
        }
        headers['Content-Length'] = Buffer.byteLength(bodyData);
      }

      const req = lib.request({
        method,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers,
        timeout: options.timeout || 30000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data });
          } catch (e) {
            resolve({ status: res.statusCode, headers: res.headers, body: data, raw: data });
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });

      if (bodyData) req.write(bodyData);
      req.end();
    });
  }

  // ==================== 认证相关 ====================

  /**
   * Cookie 登录
   * @param {string} cookie - 浏览器中移动云盘的完整 Cookie 字符串
   */
  async loginWithCookie(cookie) {
    this.cookie = cookie;
    const userInfo = await this.getUserInfo();
    return {
      accessToken: cookie,
      userId: String(userInfo.userId || ''),
      expiresAt: new Date(Date.now() + 86400 * 30 * 1000),
    };
  }

  /**
   * 检查登录状态
   * TODO: 确认移动云盘登录检查 API 的实际路径和响应格式
   */
  async checkLogin() {
    const res = await this._request('GET', API_URLS.accountInfo);
    if (!res.body) {
      throw new Error('移动云盘登录检查失败: 无响应');
    }
    // TODO: 根据实际 API 响应格式调整判断逻辑
    if (res.body.code !== undefined && res.body.code !== 0 && res.body.code !== '0') {
      throw new Error('移动云盘 Cookie 已失效，请重新登录: ' + JSON.stringify(res.body).slice(0, 200));
    }
    const data = res.body.data || res.body.result || {};
    return {
      userId: String(data.userId || data.uid || ''),
      nickname: data.nickName || data.nickname || '',
    };
  }

  async getQRCode() {
    throw new Error('移动云盘暂不支持扫码登录，请使用 Cookie 登录');
  }

  async checkQRStatus() {
    throw new Error('移动云盘暂不支持扫码登录，请使用 Cookie 登录');
  }

  async refreshToken() {
    return {
      accessToken: this.cookie,
      refreshToken: '',
      expiresAt: new Date(Date.now() + 86400 * 30 * 1000),
    };
  }

  // ==================== 文件操作 ====================

  /**
   * 列出目录下的文件
   * TODO: 确认移动云盘列文件 API 的实际参数和响应格式
   *
   * @param {string} remotePath - 网盘内路径，如 /KTV/华语
   */
  async listFiles(remotePath) {
    remotePath = this._normalizePath(remotePath);

    // 检查缓存
    const cached = this._getCache('files', remotePath);
    if (cached) return cached;

    // TODO: 确认目录 ID 获取方式。移动云盘可能也需要逐级遍历或有 path->id API
    // 临时实现：假设根目录 id 为 "0"，需要确认
    const dirId = await this._pathToDirId(remotePath);

    const params = new URLSearchParams({
      dirId: String(dirId),
      pageNo: '1',
      pageSize: '100',
    });

    const res = await this._request('GET', `${API_URLS.listFiles}?${params.toString()}`);

    // TODO: 根据实际 API 响应格式解析
    if (!res.body) {
      throw new Error('移动云盘列目录失败: 无响应');
    }

    const data = res.body.data || res.body.result || { fileList: [] };
    const fileList = data.fileList || data.list || data.files || [];

    const result = fileList.map((f) => ({
      fileId: String(f.fileId || f.id || f.fid || ''),
      name: f.fileName || f.name || '',
      path: this._joinPath(remotePath, f.fileName || f.name || ''),
      isDir: f.isFolder === true || f.isFolder === 1 || f.type === 1,
      size: parseInt(f.fileSize || f.size || '0', 10),
      modifiedAt: f.updateTime ? new Date(f.updateTime) : new Date(),
    }));

    this._setCache('files', remotePath, result);
    return result;
  }

  /**
   * 路径转目录 ID
   * TODO: 确认移动云盘路径解析 API
   */
  async _pathToDirId(remotePath) {
    remotePath = this._normalizePath(remotePath);
    if (remotePath === '/' || remotePath === '') {
      return '0'; // 根目录，待确认
    }

    const cached = this._getCache('pathIds', remotePath);
    if (cached) return cached;

    // TODO: 逐级遍历查找（与 quark 类似），或使用移动云盘的 path->id API
    // 临时抛错提示待完善
    throw new Error('移动云盘路径解析待完善，请抓包确认目录 ID 获取方式');
  }

  async getFileInfo(fileId) {
    throw new Error('移动云盘 getFileInfo 暂未实现');
  }

  /**
   * 获取下载直链
   * TODO: 确认移动云盘获取直链 API 的实际参数和响应格式
   *
   * @param {string} fileId - 文件 ID
   * @param {string} [userAgent] - 客户端 UA
   */
  async getDownloadUrl(fileId, userAgent) {
    const cacheKey = fileId;
    const cached = this._getCache('urls', cacheKey);
    if (cached) return cached;

    const res = await this._request('POST', API_URLS.getDownloadURL, {
      body: { fileIds: [String(fileId)] },
    });

    if (!res.body) {
      throw new Error('移动云盘获取下载直链失败: 无响应');
    }

    // TODO: 根据实际 API 响应格式解析下载 URL
    const data = res.body.data || res.body.result || {};
    const url = data.downloadUrl || data.url || (Array.isArray(data.fileList) && data.fileList[0] && data.fileList[0].downloadUrl);

    if (!url) {
      throw new Error('移动云盘下载直链解析失败（API 待完善）: ' + JSON.stringify(res.body).slice(0, 200));
    }

    const result = {
      url,
      expiresAt: new Date(Date.now() + 2 * 3600 * 1000),
    };

    this._setCache('urls', cacheKey, result);
    return result;
  }

  /**
   * 通过文件路径获取下载直链
   * @param {string} filePath - 文件的完整路径
   * @param {string} [userAgent] - 客户端 UA
   */
  async getDownloadUrlByPath(filePath, userAgent) {
    filePath = this._normalizePath(filePath);
    const dir = this._dirname(filePath);
    const fileName = this._basename(filePath);

    const files = await this.listFiles(dir);
    const file = files.find(f => f.name === fileName && !f.isDir);

    if (!file) {
      throw new Error(`移动云盘文件不存在: ${filePath}`);
    }

    return this.getDownloadUrl(file.fileId, userAgent);
  }

  // ==================== 上传/目录操作 ====================

  async mkdir(remotePath) {
    throw new Error('移动云盘 mkdir 暂未实现');
  }

  async uploadFile(localPath, remotePath, onProgress) {
    throw new Error('移动云盘 uploadFile 暂未实现');
  }

  // ==================== 工具方法 ====================

  async getUserInfo() {
    try {
      const info = await this.checkLogin();
      return {
        userId: info.userId,
        nickname: info.nickname || `移动云盘用户_${info.userId}`,
      };
    } catch (e) {
      return {
        userId: '',
        nickname: '移动云盘用户',
      };
    }
  }

  async testConnection() {
    try {
      await this.checkLogin();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // ==================== 路径工具 ====================

  _normalizePath(p) {
    if (!p || p === '') return '/';
    if (!p.startsWith('/')) p = '/' + p;
    const parts = p.split('/').filter(Boolean);
    return '/' + parts.join('/');
  }

  _joinPath(dir, name) {
    dir = this._normalizePath(dir);
    if (dir === '/') return '/' + name;
    return dir + '/' + name;
  }

  _dirname(path) {
    path = this._normalizePath(path);
    const parts = path.split('/').filter(Boolean);
    parts.pop();
    return '/' + parts.join('/');
  }

  _basename(path) {
    path = this._normalizePath(path);
    const parts = path.split('/').filter(Boolean);
    return parts[parts.length - 1];
  }
}

module.exports = CmccDriver;
