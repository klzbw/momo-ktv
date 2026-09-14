/**
 * 夸克网盘驱动 (quark)
 *
 * 认证方式：Cookie 登录（从浏览器复制完整 Cookie 字符串粘贴）
 * 夸克 Web 端 Cookie 关键字段：__pus, __pu, _city, __kp, __kps 等
 *
 * 核心 API（drive-pc.quark.cn）：
 * - 列文件：GET  /1/clouddrive/file/sort?pr=ucpro&fr=pc&pdir_fid=<dirId>&_page=1&_size=100
 * - 获取下载直链：POST /1/clouddrive/file/download?pr=ucpro&fr=pc  body: {"fids":["<fid>"]}
 * - 登录信息：GET /1/clouddrive/account/info
 *
 * 特点：
 * - 根目录 fid = "0"
 * - 下载直链无需加密（直接返回 CDN URL），但 CDN 响应需要 Referer: https://pan.quark.cn/
 * - CDN 域名通常是 *.quark.cn 或 *.aliyundrive.com（夸克底层用阿里云 CDN）
 * - 限流：5 req/s，缓存：目录列表 2 分钟，直链按 URL 过期时间动态 TTL
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const CloudDriveBase = require('./base');
const gbox = require('../gbox');

// API 端点
const API_URLS = {
  listFiles: 'https://drive-pc.quark.cn/1/clouddrive/file/sort',
  getDownloadURL: 'https://drive-pc.quark.cn/1/clouddrive/file/download',
  accountInfo: 'https://drive-pc.quark.cn/1/clouddrive/account/info',
};

// User-Agent（夸克桌面客户端 UA，必须与获取直链时一致）
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch';

// CDN 下载时需要的 Referer
const CDN_REFERER = 'https://pan.quark.cn/';

class QuarkDriver extends CloudDriveBase {
  constructor(account) {
    super(account);
    // Cookie 字符串，用户从浏览器夸克网盘页面复制
    this.cookie = account.access_token || '';
    this._userAgent = USER_AGENT;

    // 限流：每秒 5 个请求
    this._rateLimit = {
      maxPerSecond: 5,
      timestamps: [],
    };

    // 缓存
    this._cache = {
      files: new Map(),   // key: dirFid, value: { data, expireAt }
      urls: new Map(),    // key: fid, value: { url, expiresAt }
      pathFids: new Map(), // key: path, value: { fid, expireAt }
    };
    this._cacheTTL = 2 * 60 * 1000; // 2 分钟
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
        'Referer': CDN_REFERER,
        'Origin': 'https://pan.quark.cn',
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
   * @param {string} cookie - 浏览器中夸克网盘的完整 Cookie 字符串
   */
  async loginWithCookie(cookie) {
    this.cookie = cookie;
    const userInfo = await this.getUserInfo();
    return {
      accessToken: cookie,
      userId: String(userInfo.userId || ''),
      expiresAt: new Date(Date.now() + 86400 * 30 * 1000), // 约30天
    };
  }

  /**
   * 检查登录状态
   */
  async checkLogin() {
    const res = await this._request('GET', API_URLS.accountInfo + '?pr=ucpro&fr=pc');
    if (!res.body || res.body.code !== 0) {
      throw new Error('夸克登录检查失败: ' + JSON.stringify(res.body).slice(0, 200));
    }
    const info = res.body.data || {};
    return { userId: String(info.uid || info.user_id || ''), nickname: info.nickname || info.name || '' };
  }

  async getQRCode() {
    // 扫码登录代理到 G-Box：GET /api/qrcode_quark 返回 PNG，token 在响应头；
    // GET /api/status_quark?token=xxx 轮询，成功时返回 cookie。
    const r = await gbox.call('/api/qrcode_quark', 'GET', null, { raw: true });
    const qrToken = r.headers && (r.headers.token || r.headers.Token);
    if (!qrToken || !Buffer.isBuffer(r.body) || r.body.length < 100) {
      throw new Error('获取夸克二维码失败，请检查 G-Box 是否正常');
    }
    return {
      qrId: qrToken,
      qrImage: 'data:image/png;base64,' + r.body.toString('base64'),
      expiresIn: 120,
    };
  }

  async checkQRStatus(qrId) {
    if (!qrId) return { status: 'waiting' };
    const r = await gbox.call('/api/status_quark?token=' + encodeURIComponent(qrId), 'GET');
    const j = r.json || {};
    if (j.status === 'success' && j.cookie) {
      return {
        status: 'confirmed',
        tokens: { access_token: j.cookie, refresh_token: j.cookie, expires_in: 0 },
      };
    }
    if (j.status === 'expired') return { status: 'expired' };
    return { status: 'waiting' };
  }

  async refreshToken() {
    // Cookie 模式不支持自动刷新，返回当前 cookie
    return {
      accessToken: this.cookie,
      refreshToken: '',
      expiresAt: new Date(Date.now() + 86400 * 30 * 1000),
    };
  }

  // ==================== 文件操作 ====================

  /**
   * 列出目录下的文件
   * @param {string} remotePath - 网盘内路径，如 /KTV/华语
   */
  async listFiles(remotePath) {
    remotePath = this._normalizePath(remotePath);

    // 通过路径找到目录 fid
    const dirFid = await this._pathToFid(remotePath);

    // 检查缓存
    const cached = this._getCache('files', dirFid + '@' + remotePath);
    if (cached) return cached;

    // 分页获取所有文件
    const pageSize = 100;
    let page = 1;
    let allFiles = [];
    let total = 0;

    do {
      const params = new URLSearchParams({
        pr: 'ucpro',
        fr: 'pc',
        pdir_fid: dirFid,
        _page: String(page),
        _size: String(pageSize),
        _sort: 'file_type:asc,file_name:asc',
      });

      const res = await this._request('GET', `${API_URLS.listFiles}?${params.toString()}`);
      if (!res.body || res.body.code !== 0) {
        throw new Error('夸克列目录失败: ' + JSON.stringify(res.body).slice(0, 200));
      }

      const data = res.body.data || {};
      const list = data.list || [];
      total = (data.metadata && data.metadata._total) ? parseInt(data.metadata._total, 10) : list.length;
      allFiles = allFiles.concat(list);
      page++;
    } while (allFiles.length < total && allFiles.length > 0);

    const result = allFiles.map((f) => {
      const isDir = f.dir === true || f.dir === 1 || f.type === 'dir';
      return {
        fileId: String(f.fid || ''),
        name: f.file_name || f.name || '',
        path: this._joinPath(remotePath, f.file_name || f.name || ''),
        isDir: isDir,
        size: parseInt(f.size || '0', 10),
        modifiedAt: f.modified_at ? new Date(f.modified_at * 1000) : new Date(),
        sha1: f.sha1 || '',
        fileType: f.file_type || f.type || '',
      };
    });

    this._setCache('files', dirFid + '@' + remotePath, result);
    return result;
  }

  /**
   * 路径转 fid（逐级遍历目录）
   * 夸克没有直接的 path->fid API，需要逐级 listFiles 查找
   */
  async _pathToFid(remotePath) {
    remotePath = this._normalizePath(remotePath);

    if (remotePath === '/' || remotePath === '') {
      return '0';
    }

    // 检查缓存
    const cached = this._getCache('pathFids', remotePath);
    if (cached) return cached;

    const parts = remotePath.split('/').filter(Boolean);
    let currentFid = '0';

    for (const part of parts) {
      // 列出当前目录
      const dirKey = currentFid;
      let files = this._getCache('files', dirKey);
      if (!files) {
        const params = new URLSearchParams({
          pr: 'ucpro',
          fr: 'pc',
          pdir_fid: currentFid,
          _page: '1',
          _size: '100',
          _sort: 'file_type:asc,file_name:asc',
        });
        const res = await this._request('GET', `${API_URLS.listFiles}?${params.toString()}`);
        if (!res.body || res.body.code !== 0) {
          throw new Error('夸克列目录失败(pathToFid): ' + JSON.stringify(res.body).slice(0, 200));
        }
        files = (res.body.data.list || []).map((f) => ({
          fileId: String(f.fid || ''),
          name: f.file_name || '',
          isDir: f.dir === true || f.dir === 1,
        }));
        this._setCache('files', dirKey, files);
      }

      // 查找匹配的子目录
      const matched = files.find(f => f.name === part && f.isDir);
      if (!matched) {
        throw new Error(`夸克路径不存在: ${remotePath} (找不到 ${part})`);
      }
      currentFid = matched.fileId;
    }

    this._setCache('pathFids', remotePath, currentFid);
    return currentFid;
  }

  /**
   * 获取文件详情
   */
  async getFileInfo(fileId) {
    throw new Error('夸克 getFileInfo 暂未实现，请用 listFiles');
  }

  /**
   * 获取下载直链
   * @param {string} fid - 文件的 fid
   * @param {string} [userAgent] - 客户端 UA（夸克 CDN 对 UA 绑定较宽松，透传即可）
   */
  async getDownloadUrl(fid, userAgent) {
    // 缓存 key
    const cacheKey = fid;
    const cached = this._getCache('urls', cacheKey);
    if (cached) return cached;

    const res = await this._request('POST', `${API_URLS.getDownloadURL}?pr=ucpro&fr=pc`, {
      body: { fids: [String(fid)] },
    });

    if (!res.body || res.body.code !== 0) {
      throw new Error('夸克获取下载直链失败: ' + JSON.stringify(res.body).slice(0, 200));
    }

    const dataList = res.body.data || [];
    if (!Array.isArray(dataList) || dataList.length === 0 || !dataList[0].download_url) {
      throw new Error('夸克下载直链解析失败: ' + JSON.stringify(res.body).slice(0, 200));
    }

    const downloadUrl = dataList[0].download_url;

    // 智能缓存：尝试解析 URL 中的过期参数
    let cacheTTL = 2 * 3600 * 1000; // 默认2小时
    let expiresAt = new Date(Date.now() + cacheTTL);
    try {
      const urlObj = new URL(downloadUrl);
      // 夸克 CDN URL 常见的过期参数： expires, time, t
      const expParam = urlObj.searchParams.get('expires') || urlObj.searchParams.get('time') || urlObj.searchParams.get('t');
      if (expParam) {
        let expireTimestamp = parseInt(expParam, 10);
        if (!isNaN(expireTimestamp)) {
          // 如果参数 < 1e12，可能是秒级时间戳
          if (expireTimestamp < 1e12) expireTimestamp *= 1000;
          if (expireTimestamp > Date.now()) {
            cacheTTL = expireTimestamp - Date.now() - 5 * 60 * 1000;
            if (cacheTTL < 60 * 1000) cacheTTL = 60 * 1000;
            if (cacheTTL > 12 * 3600 * 1000) cacheTTL = 12 * 3600 * 1000;
            expiresAt = new Date(expireTimestamp);
          }
        }
      }
    } catch (e) {
      // URL 解析失败，使用默认值
    }

    const result = { url: downloadUrl, expiresAt };
    this._setCache('urls', cacheKey, result, cacheTTL);
    return result;
  }

  /**
   * 通过文件路径获取下载直链
   * @param {string} filePath - 文件的完整路径，如 /KTV/华语/xxx.mkv
   * @param {string} [userAgent] - 客户端 UA（透传）
   */
  async getDownloadUrlByPath(filePath, userAgent) {
    filePath = this._normalizePath(filePath);
    const dir = this._dirname(filePath);
    const fileName = this._basename(filePath);

    const files = await this.listFiles(dir);
    const file = files.find(f => f.name === fileName && !f.isDir);

    if (!file) {
      throw new Error(`夸克文件不存在: ${filePath}`);
    }

    return this.getDownloadUrl(file.fileId, userAgent);
  }

  // ==================== 上传/目录操作 ====================

  async mkdir(remotePath) {
    throw new Error('夸克 mkdir 暂未实现');
  }

  async uploadFile(localPath, remotePath, onProgress) {
    throw new Error('夸克 uploadFile 暂未实现');
  }

  // ==================== 工具方法 ====================

  async getUserInfo() {
    try {
      const info = await this.checkLogin();
      return {
        userId: info.userId,
        nickname: info.nickname || `夸克用户_${info.userId}`,
      };
    } catch (e) {
      return {
        userId: '',
        nickname: '夸克用户',
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

module.exports = QuarkDriver;
