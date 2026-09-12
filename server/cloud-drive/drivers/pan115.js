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
  // 分享链接相关
  getShareSnap: 'https://webapi.115.com/share/snap',
  getShareFileList: 'https://webapi.115.com/share/filelist',
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
      shareSnaps: new Map(), // key: snap:pickcode, value: 分享快照
      shareFiles: new Map(), // key: share:shareId:cid, value: 文件列表
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
   * @param {string} [userAgent] - 自定义 UA。115 CDN 的下载 URL 签名与请求 API 时的 UA 绑定，
   *   必须用客户端（VLC/浏览器）的 UA 调用 API，生成的 URL 客户端才能下载（否则 403 invalid signature）。
   *   不传则用默认 115Browser UA。
   */
  async getDownloadUrl(pickCode, userAgent) {
    // 缓存 key 必须包含 UA：不同 UA 生成的 URL 签名不同，混用会导致 403
    const cacheKey = userAgent ? `${pickCode}|${userAgent}` : pickCode;
    // 检查缓存
    const cached = this._getCache('urls', cacheKey);
    if (cached) return cached;

    // 生成随机 key
    const key = crypto115.generateKey();

    // 构造请求参数
    const params = JSON.stringify({ pickcode: pickCode });

    // 加密
    const encryptedData = crypto115.encode(params, key);

    // 发送请求（自定义 UA 通过 headers 覆盖默认 115Browser UA）
    const timestamp = Math.floor(Date.now() / 1000);
    const reqOptions = {
      body: { data: encryptedData },
      contentType: 'application/x-www-form-urlencoded',
    };
    if (userAgent) {
      reqOptions.headers = { 'User-Agent': userAgent };
    }
    const res = await this._request('POST', `${API_URLS.getDownloadURL}?t=${timestamp}`, reqOptions);

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

    // 智能缓存：解析URL中的t参数（过期时间戳），动态设置缓存时间
    let cacheTTL = 4 * 3600 * 1000; // 默认4小时
    let expiresAt = new Date(Date.now() + cacheTTL);
    try {
      const urlObj = new URL(url);
      const tParam = urlObj.searchParams.get('t');
      if (tParam) {
        const expireTimestamp = parseInt(tParam, 10) * 1000; // 秒转毫秒
        if (!isNaN(expireTimestamp) && expireTimestamp > Date.now()) {
          // 提前5分钟过期，确保安全边界
          cacheTTL = expireTimestamp - Date.now() - 5 * 60 * 1000;
          if (cacheTTL < 60 * 1000) cacheTTL = 60 * 1000; // 最少1分钟
          if (cacheTTL > 12 * 3600 * 1000) cacheTTL = 12 * 3600 * 1000; // 最多12小时
          expiresAt = new Date(expireTimestamp);
        }
      }
    } catch (e) {
      // URL解析失败，使用默认值
    }

    const result = {
      url,
      expiresAt,
    };

    // 写入缓存（使用智能TTL，key含UA）
    this._setCache('urls', cacheKey, result, cacheTTL);

    return result;
  }

  /**
   * 通过文件路径获取下载直链
   * @param {string} filePath - 文件的完整路径
   * @param {string} [userAgent] - 自定义 UA（透传给 getDownloadUrl，使URL签名匹配客户端UA）
   */
  async getDownloadUrlByPath(filePath, userAgent) {
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

    return this.getDownloadUrl(file.pickCode, userAgent);
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
// ==================== 分享链接相关 ====================

  /**
   * 解析 115 分享链接，获取分享快照信息
   * @param {string} pickcode - 分享链接的 pickcode
   * @returns {Promise<{shareId: string, title: string, fileCount: number, size: number}>}
   */
  async getShareSnap(pickcode) {
    const cacheKey = `snap:${pickcode}`;
    const cached = this._getCache('shareSnaps', cacheKey);
    if (cached) return cached;

    const res = await this._request('GET', `${API_URLS.getShareSnap}?pickcode=${encodeURIComponent(pickcode)}`);
    if (!res.body || res.body.state !== true || !res.body.data) {
      throw new Error('115 分享链接解析失败: ' + JSON.stringify(res.body).slice(0, 200));
    }

    const data = res.body.data;
    const result = {
      shareId: String(data.share_id || data.id || ''),
      title: data.title || data.name || '',
      fileCount: parseInt(data.file_count || data.count || 0, 10),
      size: parseInt(data.size || 0, 10),
      pickcode,
    };

    this._setCache('shareSnaps', cacheKey, result, 30 * 60 * 1000); // 缓存30分钟
    return result;
  }

  /**
   * 获取分享链接中的文件列表
   * @param {string} shareId - 分享ID
   * @param {string} pickcode - 分享 pickcode
   * @param {string} [cid] - 目录ID，默认根目录 '0'
   * @returns {Promise<Array>} 文件列表
   */
  async listShareFiles(shareId, pickcode, cid = '0') {
    const cacheKey = `share:${shareId}:${cid}`;
    const cached = this._getCache('shareFiles', cacheKey);
    if (cached) return cached;

    const pageSize = 1000;
    let offset = 0;
    let allFiles = [];
    let total = 0;

    do {
      const params = new URLSearchParams({
        share_id: shareId,
        pickcode: pickcode,
        cid: cid,
        offset: String(offset),
        limit: String(pageSize),
        show_dir: '1',
      });

      const res = await this._request('GET', `${API_URLS.getShareFileList}?${params.toString()}`);
      if (!res.body || res.body.state !== true) {
        throw new Error('115 分享文件列表获取失败: ' + JSON.stringify(res.body).slice(0, 200));
      }

      const files = res.body.data || [];
      total = res.body.count || 0;
      allFiles = allFiles.concat(files);
      offset += pageSize;
    } while (offset < total);

    const result = allFiles.map((f) => ({
      fileId: String(f.fid || f.cid || f.id),
      name: f.n || f.name,
      isDir: f.fid === 0 || f.ica === 1 || f.is_dir === 1,
      size: parseInt(f.s || f.size || 0, 10),
      pickCode: f.pc || f.pickcode,
      cid: String(f.cid || f.id || '0'),
      modifiedAt: f.te ? new Date(f.te * 1000) : new Date(),
    }));

    this._setCache('shareFiles', cacheKey, result, 10 * 60 * 1000); // 缓存10分钟
    return result;
  }

  /**
   * 递归获取分享链接中的所有视频文件
   * @param {string} shareId - 分享ID
   * @param {string} pickcode - 分享 pickcode
   * @param {string} [cid] - 起始目录ID
   * @param {string} [basePath] - 基础路径
   * @returns {Promise<Array>} 所有视频文件
   */
  async listAllShareVideos(shareId, pickcode, cid = '0', basePath = '') {
    const files = await this.listShareFiles(shareId, pickcode, cid);
    const videos = [];
    const videoExts = ['.mkv', '.mp4', '.avi', '.ts', '.flv', '.wmv', '.mov', '.m4v'];

    for (const f of files) {
      const fullPath = basePath ? `${basePath}/${f.name}` : f.name;
      if (f.isDir) {
        // 递归子目录
        try {
          const subVideos = await this.listAllShareVideos(shareId, pickcode, f.cid, fullPath);
          videos.push(...subVideos);
        } catch (e) {
          console.warn(`[115Share] 跳过目录 ${fullPath}: ${e.message}`);
        }
      } else {
        const ext = '.' + (f.name.split('.').pop() || '').toLowerCase();
        if (videoExts.includes(ext)) {
          videos.push({
            ...f,
            path: fullPath,
            shareId,
            pickcode,
          });
        }
      }
    }

    return videos;
  }

  /**
   * 获取分享文件的下载直链（复用 getDownloadUrl，分享文件也有 pickCode）
   * @param {string} pickCode - 文件的 pickCode
   * @param {string} [userAgent] - 自定义 UA
   */
  async getShareDownloadUrl(pickCode, userAgent) {
    return this.getDownloadUrl(pickCode, userAgent);
  }

}
module.exports = Pan115Driver;
