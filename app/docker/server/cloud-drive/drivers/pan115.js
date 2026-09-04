/**
 * 115 网盘驱动（v2 - 参考 115drive-webdav 实现）
 *
 * 认证方式：Cookie 登录（UID + CID + SEID + KID）
 * 建议使用 App 端 Cookie（时效更长）
 *
 * 核心 API：
 * - 文件列表：https://webapi.115.com/files
 * - 目录ID：https://webapi.115.com/files/getid
 * - 下载直链：https://proapi.115.com/app/chrome/downurl（需 XOR+RSA 加密）
 * - 登录检查：https://passportapi.115.com/app/1.0/web/1.0/check/sso
 *
 * 参考项目：https://github.com/gaoyb7/115drive-webdav
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const CloudDriveBase = require('./base');
const crypto115 = require('./crypto');

// API 端点
const API_URLS = {
  getFiles: 'https://webapi.115.com/files',
  getDownloadURL: 'https://proapi.115.com/app/chrome/downurl',
  getDirID: 'https://webapi.115.com/files/getid',
  deleteFile: 'https://webapi.115.com/rb/delete',
  addDir: 'https://webapi.115.com/files/add',
  moveFile: 'https://webapi.115.com/files/move',
  renameFile: 'https://webapi.115.com/files/batch_rename',
  loginCheck: 'https://passportapi.115.com/app/1.0/web/1.0/check/sso',
};

// User-Agent（必须用 115 浏览器 UA）
const USER_AGENT = 'Mozilla/5.0 115Browser/23.9.3.2';

class Pan115Driver extends CloudDriveBase {
  constructor(account) {
    super(account);
    // Cookie 字符串，格式：UID=xxx; CID=xxx; SEID=xxx; KID=xxx
    this.cookie = account.access_token || '';
    this._userAgent = USER_AGENT;

    // 限流：每秒 5 个请求（参考 115drive-webdav）
    this._rateLimit = {
      maxPerSecond: 5,
      timestamps: [],
    };

    // 缓存
    this._cache = {
      files: new Map(), // key: dir, value: { data, expireAt }
      urls: new Map(),  // key: pickCode, value: { url, expireAt }
      dirIds: new Map(), // key: path, value: { cid, expireAt }
    };
    this._cacheTTL = 2 * 60 * 1000; // 2 分钟
  }

  // ==================== 限流控制 ====================

  async _acquireRateLimit() {
    const now = Date.now();
    const windowStart = now - 1000;
    // 移除过期的时间戳
    this._rateLimit.timestamps = this._rateLimit.timestamps.filter(t => t > windowStart);

    if (this._rateLimit.timestamps.length >= this._rateLimit.maxPerSecond) {
      // 等待最旧的请求过期
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

  _setCache(type, key, data) {
    const cache = this._cache[type];
    if (!cache) return;
    cache.set(key, {
      data,
      expireAt: Date.now() + this._cacheTTL,
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

      if (options.body) {
        headers['Content-Type'] = options.contentType || 'application/x-www-form-urlencoded';
        if (typeof options.body === 'object') {
          options.body = new URLSearchParams(options.body).toString();
        }
        headers['Content-Length'] = Buffer.byteLength(options.body);
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

      if (options.body) req.write(options.body);
      req.end();
    });
  }

  // ==================== 认证相关 ====================

  /**
   * Cookie 登录（推荐使用 App 端 Cookie）
   * @param {string} cookie - Cookie 字符串（UID=xxx; CID=xxx; SEID=xxx; KID=xxx）
   */
  async loginWithCookie(cookie) {
    this.cookie = cookie;
    const userInfo = await this.checkLogin();
    return {
      accessToken: cookie,
      userId: userInfo.userId,
      expiresAt: new Date(Date.now() + 86400 * 30 * 1000), // 约30天
    };
  }

  /**
   * 检查登录状态
   */
  async checkLogin() {
    const res = await this._request('GET', API_URLS.loginCheck);
    if (!res.body || !res.body.data) {
      throw new Error('115 登录检查失败: ' + JSON.stringify(res.body).slice(0, 200));
    }
    const userId = parseInt(res.body.data.user_id || '0', 10);
    if (userId <= 0) {
      throw new Error('115 Cookie 已失效，请重新登录');
    }
    return { userId };
  }

  /**
   * 旧的扫码登录（接口已失效，保留兼容）
   */
  async getQRCode() {
    throw new Error('115 扫码登录接口已失效，请使用 Cookie 登录');
  }

  async checkQRStatus() {
    throw new Error('115 扫码登录接口已失效，请使用 Cookie 登录');
  }

  /**
   * 刷新 Token（115 不支持，返回当前 Cookie）
   */
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
   */
  async listFiles(remotePath) {
    remotePath = this._normalizePath(remotePath);

    // 检查缓存
    const cached = this._getCache('files', remotePath);
    if (cached) return cached;

    // 获取目录 ID
    const cid = await this._pathToCid(remotePath);

    // 分页获取所有文件
    const pageSize = 1000;
    let offset = 0;
    let allFiles = [];
    let total = 0;

    do {
      const params = new URLSearchParams({
        aid: '1',
        cid: cid,
        o: 'user_ptime',
        asc: '0',
        offset: String(offset),
        show_dir: '1',
        limit: String(pageSize),
        snap: '0',
        record_open_time: '1',
        format: 'json',
        fc_mix: '0',
      });

      const res = await this._request('GET', `${API_URLS.getFiles}?${params.toString()}`);
      if (!res.body || res.body.state !== true) {
        throw new Error('115 列目录失败: ' + JSON.stringify(res.body).slice(0, 200));
      }

      const files = res.body.data || [];
      total = res.body.count || 0;
      allFiles = allFiles.concat(files);
      offset += pageSize;
    } while (offset < total);

    const result = allFiles.map((f) => ({
      fileId: String(f.fid || f.cid || f.id),
      name: f.n || f.name,
      path: this._joinPath(remotePath, f.n || f.name),
      isDir: f.fid === 0 || f.ica === 1 || f.is_dir === 1,
      size: parseInt(f.s || f.size || 0, 10),
      modifiedAt: f.te ? new Date(f.te * 1000) : new Date(),
      pickCode: f.pc || f.pickcode,
      sha1: f.sha,
      fileType: f.te || f.file_type,
    }));

    // 写入缓存
    this._setCache('files', remotePath, result);

    return result;
  }

  /**
   * 路径转 cid
   */
  async _pathToCid(remotePath) {
    remotePath = this._normalizePath(remotePath);

    if (remotePath === '/' || remotePath === '') {
      return '0';
    }

    // 检查缓存
    const cached = this._getCache('dirIds', remotePath);
    if (cached) return cached;

    // 去掉开头的 /
    const path = remotePath.startsWith('/') ? remotePath.slice(1) : remotePath;

    const res = await this._request('GET', `${API_URLS.getDirID}?path=${encodeURIComponent(path)}`);
    if (!res.body || res.body.state !== true) {
      throw new Error('115 获取目录ID失败: ' + JSON.stringify(res.body).slice(0, 200));
    }

    const cid = String(res.body.id || res.body.category_id || '0');

    // 写入缓存
    this._setCache('dirIds', remotePath, cid);

    return cid;
  }

  /**
   * 获取文件详情
   */
  async getFileInfo(fileId) {
    // 115 没有单独的文件详情接口，用 listFiles 查找
    throw new Error('getFileInfo not implemented, use listFiles instead');
  }

  /**
   * 获取下载直链（使用加密 API）
   * @param {string} pickCode - 文件的 pickCode
   */
  async getDownloadUrl(pickCode) {
    // 检查缓存
    const cached = this._getCache('urls', pickCode);
    if (cached) return cached;

    // 生成随机 key
    const key = crypto115.generateKey();

    // 构造请求参数
    const params = JSON.stringify({ pickcode: pickCode });

    // 加密
    const encryptedData = crypto115.encode(params, key);

    // 发送请求
    const timestamp = Math.floor(Date.now() / 1000);
    const res = await this._request('POST', `${API_URLS.getDownloadURL}?t=${timestamp}`, {
      body: { data: encryptedData },
      contentType: 'application/x-www-form-urlencoded',
    });

    if (!res.body || res.body.state !== true || !res.body.data) {
      throw new Error('115 获取下载直链失败: ' + JSON.stringify(res.body).slice(0, 200));
    }

    // 解密响应数据
    const encodedData = typeof res.body.data === 'string' ? res.body.data : JSON.stringify(res.body.data);
    const decryptedData = crypto115.decode(encodedData, key);
    const downloadData = JSON.parse(decryptedData.toString());

    // downloadData 是一个 map，key 是文件名，value 是下载信息
    // 取第一个有效的下载链接
    let url = null;
    for (const fileName of Object.keys(downloadData)) {
      const info = downloadData[fileName];
      const fileSize = parseInt(info.file_size || '0', 10);
      if (fileSize > 0 && info.url && info.url.url) {
        url = info.url.url;
        break;
      }
    }

    if (!url) {
      throw new Error('115 下载直链解析失败: ' + decryptedData.toString().slice(0, 200));
    }

    const result = {
      url,
      expiresAt: new Date(Date.now() + 4 * 3600 * 1000), // 约4小时有效
    };

    // 写入缓存
    this._setCache('urls', pickCode, result);

    return result;
  }

  /**
   * 通过文件路径获取下载直链
   * @param {string} filePath - 文件的完整路径
   */
  async getDownloadUrlByPath(filePath) {
    filePath = this._normalizePath(filePath);
    const dir = this._dirname(filePath);
    const fileName = this._basename(filePath);

    const files = await this.listFiles(dir);
    const file = files.find(f => f.name === fileName);

    if (!file) {
      throw new Error(`115 文件不存在: ${filePath}`);
    }

    if (!file.pickCode) {
      throw new Error(`115 文件没有 pickCode: ${filePath}`);
    }

    return this.getDownloadUrl(file.pickCode);
  }

  // ==================== 上传/目录操作 ====================

  /**
   * 创建目录
   */
  async mkdir(remotePath) {
    remotePath = this._normalizePath(remotePath);

    // 先检查是否已存在
    try {
      const cid = await this._pathToCid(remotePath);
      if (cid !== '0') {
        return cid; // 已存在
      }
    } catch (e) {
      // 不存在，继续创建
    }

    const parts = remotePath.split('/').filter(Boolean);
    const name = parts.pop();
    const parentPath = '/' + parts.join('/');
    const parentCid = parentPath === '/' ? '0' : await this._pathToCid(parentPath);

    const res = await this._request('POST', API_URLS.addDir, {
      body: { pid: parentCid, cname: name },
    });

    if (!res.body || !res.body.state) {
      throw new Error('115 创建目录失败: ' + JSON.stringify(res.body));
    }

    // 清除缓存
    this._cache.files.delete(parentPath);
    this._cache.dirIds.delete(remotePath);

    return String(res.body.cid || res.body.id);
  }

  /**
   * 上传文件（未实现，115 上传较复杂）
   */
  async uploadFile(localPath, remotePath, onProgress) {
    throw new Error('115 uploadFile not implemented yet');
  }

  // ==================== 工具方法 ====================

  /**
   * 获取用户信息
   */
  async getUserInfo() {
    // 115 没有单独的用户信息接口，用登录检查代替
    const loginInfo = await this.checkLogin();
    return {
      userId: loginInfo.userId,
      nickname: `115用户_${loginInfo.userId}`,
    };
  }

  /**
   * 测试连接
   */
  async testConnection() {
    try {
      await this.checkLogin();
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // ==================== 路径工具 ====================

  _normalizePath(path) {
    if (!path || path === '') return '/';
    if (!path.startsWith('/')) path = '/' + path;
    // 规范化路径
    const parts = path.split('/').filter(Boolean);
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

module.exports = Pan115Driver;
