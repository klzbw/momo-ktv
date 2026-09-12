/**
 * Alist 网盘驱动
 *
 * 连接任意 Alist 实例（如 gbox 内置的 Alist），通过 Alist API 浏览和下载文件。
 * Alist 支持 100+ 种网盘（115、阿里云盘、百度网盘、迅雷、移动云盘、Google Drive、OneDrive 等），
 * 通过此驱动，momo-ktv 可直接使用 gbox 中已配置的全部 50 个存储挂载。
 *
 * 认证方式：
 *   - access_token: Alist API token（可选，公开存储无需 token）
 *   - refresh_token: Alist 实例基础 URL（如 http://192.168.3.16:5234）
 *
 * 核心 API（Alist Open API v3）：
 *   - 文件列表：POST {baseUrl}/api/fs/list  body: {path, password, page, per_page, refresh}
 *   - 文件信息：POST {baseUrl}/api/fs/get   body: {path, password}
 *   - 用户信息：GET  {baseUrl}/api/me
 *
 * 注意：Alist 的下载链接可能是 302 重定向，需要跟随重定向获取真实直链。
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const CloudDriveBase = require('./base');

class AlistDriver extends CloudDriveBase {
  constructor(account) {
    super(account);
    this.apiToken = account.access_token || '';
    // refresh_token 格式: baseUrl|username|password
    // 例如: http://127.0.0.1:5234|admin|Dd112233
    const refreshParts = (account.refresh_token || 'http://127.0.0.1:5234|admin|admin').split('|');
    this.baseUrl = (refreshParts[0] || 'http://127.0.0.1:5234').replace(/\/+$/, '');
    this.username = refreshParts[1] || 'admin';
    this.password = refreshParts[2] || 'admin';
    this._tokenExpiresAt = 0;
    this._cache = {
      files: new Map(),
      urls: new Map(),
    };
    this._cacheTTL = 60 * 1000; // Alist 文件列表缓存 60 秒
  }

  /**
   * 确保有有效的 API token，如无或过期则自动登录获取
   */
  async _ensureToken() {
    if (this.apiToken && Date.now() < this._tokenExpiresAt) {
      return this.apiToken;
    }
    const url = new URL(this.baseUrl + '/api/auth/login');
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ username: this.username, password: this.password });
      const req = lib.request({
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.code === 200 && json.data && json.data.token) {
              this.apiToken = json.data.token;
              this._tokenExpiresAt = Date.now() + (json.data.expires_in || 48) * 60 * 60 * 1000 - 60000;
              resolve(this.apiToken);
            } else {
              reject(new Error('Alist login failed: ' + (json.message || 'unknown')));
            }
          } catch (e) {
            reject(new Error('Alist login parse error: ' + e.message));
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Alist login timeout')); });
      req.write(body);
      req.end();
    });
  }

  // ==================== HTTP 工具 ====================

  async _request(method, apiPath, body = null, followRedirect = true) {
    const url = new URL(this.baseUrl + apiPath);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'momo-ktv-alist-driver/1.0',
    };
    if (this.apiToken) {
      headers['Authorization'] = this.apiToken;
    }

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
    };

    return new Promise((resolve, reject) => {
      const req = lib.request(options, (res) => {
        // 处理重定向
        if (followRedirect && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, this.baseUrl);
          const redirectLib = redirectUrl.protocol === 'https:' ? https : http;
          const redirectOpts = {
            hostname: redirectUrl.hostname,
            port: redirectUrl.port || (redirectUrl.protocol === 'https:' ? 443 : 80),
            path: redirectUrl.pathname + redirectUrl.search,
            method: 'GET',
            headers: { 'User-Agent': 'momo-ktv-alist-driver/1.0' },
          };
          const redirectReq = redirectLib.request(redirectOpts, (redirectRes) => {
            let data = '';
            redirectRes.on('data', c => data += c);
            redirectRes.on('end', () => resolve({ status: redirectRes.statusCode, body: data, headers: redirectRes.headers }));
          });
          redirectReq.on('error', reject);
          redirectReq.setTimeout(30000, () => { redirectReq.destroy(); reject(new Error('Alist redirect timeout')); });
          redirectReq.end();
          return;
        }

        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch (e) { /* not JSON */ }
          resolve({ status: res.statusCode, body: data, json, headers: res.headers });
        });
      });

      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('Alist API timeout')); });

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  // ==================== 认证相关 ====================

  async refreshToken() {
    // Alist token 通常长期有效，无需刷新
    // 如果 token 失效，需要用户重新在 Alist 后台生成
    return { accessToken: this.apiToken, refreshToken: this.baseUrl };
  }

  // ==================== 文件操作 ====================

  async listFiles(remotePath) {
    const normalized = this._normalizePath(remotePath);
    const cacheKey = normalized;
    const cached = this._cache.files.get(cacheKey);
    if (cached && Date.now() < cached.expireAt) {
      return cached.data;
    }

    // 确保有有效的 token
    await this._ensureToken();

    const allFiles = [];
    let page = 1;
    const perPage = 200;

    while (true) {
      const result = await this._request('POST', '/api/fs/list', {
        path: normalized,
        password: '',
        page,
        per_page: perPage,
        refresh: false,
      });

      if (!result.json || result.json.code !== 200) {
        const errMsg = result.json ? result.json.message : `HTTP ${result.status}`;
        throw new Error(`Alist listFiles 失败 (${normalized}): ${errMsg}`);
      }

      const content = result.json.data && result.json.data.content;
      if (content && content.length > 0) {
        allFiles.push(...content);
        if (content.length < perPage) break;
        page++;
      } else {
        break;
      }
    }

    const files = allFiles.map(item => ({
      fileId: item.path || (normalized + '/' + item.name),
      name: item.name,
      path: item.path || (normalized + '/' + item.name),
      isDir: item.is_dir,
      size: item.size || 0,
      modifiedAt: item.modified ? new Date(item.modified) : null,
      // Alist 用完整路径获取下载链接
      pickCode: item.path || (normalized + '/' + item.name),
      // 额外信息
      sign: item.sign,
      thumb: item.thumb,
      type: item.type,
    }));

    this._cache.files.set(cacheKey, { data: files, expireAt: Date.now() + this._cacheTTL });
    return files;
  }

  async getFileInfo(fileId) {
    const result = await this._request('POST', '/api/fs/get', {
      path: fileId,
      password: '',
    });
    return result.json;
  }

  async getDownloadUrl(fileId) {
    // 检查缓存
    const cached = this._cache.urls.get(fileId);
    if (cached && Date.now() < cached.expireAt) {
      return cached.data;
    }

    // 确保有有效的 token
    await this._ensureToken();

    const result = await this._request('POST', '/api/fs/get', {
      path: fileId,
      password: '',
    });

    if (!result.json || result.json.code !== 200 || !result.json.data) {
      const errMsg = result.json ? result.json.message : `HTTP ${result.status}`;
      throw new Error(`Alist getDownloadUrl 失败 (${fileId}): ${errMsg}`);
    }

    const rawUrl = result.json.data.raw_url;
    if (!rawUrl) {
      throw new Error(`Alist 未返回下载链接 (${fileId})，可能需要登录或存储未就绪`);
    }

    // raw_url 可能是相对路径或绝对路径
    let url = rawUrl;
    if (url.startsWith('//')) {
      url = 'http:' + url;
    } else if (url.startsWith('/')) {
      url = this.baseUrl + url;
    }

    const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000); // Alist 链接通常 4 小时有效

    const data = { url, expiresAt };
    this._cache.urls.set(fileId, { data, expireAt: expiresAt.getTime() - 60000 });
    return data;
  }

  // ==================== 上传相关 ====================

  async mkdir(remotePath) {
    throw new Error('Alist 驱动暂不支持创建目录（请在 Alist 后台管理）');
  }

  async uploadFile(localPath, remotePath, onProgress) {
    throw new Error('Alist 驱动暂不支持上传（请在 Alist 后台管理）');
  }

  // ==================== 工具 ====================

  async getUserInfo() {
    try {
      const result = await this._request('GET', '/api/me');
      if (result.json && result.json.code === 200 && result.json.data) {
        return {
          nickname: result.json.data.username || 'Alist 用户',
          totalSize: 0,
          usedSize: 0,
          avatar: '',
          role: result.json.data.role,
          alistUrl: this.baseUrl,
        };
      }
    } catch (e) {
      // 公开访问可能无法获取用户信息
    }
    return {
      nickname: 'Alist (' + this.baseUrl + ')',
      totalSize: 0,
      usedSize: 0,
      avatar: '',
      alistUrl: this.baseUrl,
    };
  }

  /**
   * 测试 Alist 连接
   */
  async testConnection() {
    const result = await this._request('GET', '/api/public/settings');
    if (result.status === 200) {
      return { ok: true, message: 'Alist 连接成功', baseUrl: this.baseUrl };
    }
    throw new Error(`Alist 连接失败: HTTP ${result.status}`);
  }
}

module.exports = AlistDriver;
