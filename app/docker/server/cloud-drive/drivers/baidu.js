/**
 * 百度网盘驱动
 *
 * 认证方式：OAuth2 access_token
 * 获取方式：通过百度网盘开放平台 OAuth 授权获取 access_token
 *   - access_token: 访问令牌（作为 query 参数）
 *   - refresh_token: 刷新令牌（可选）
 *
 * 核心 API（XPan Open API）：
 * - 用户信息：GET https://pan.baidu.com/rest/2.0/xpan/nas?method=uinfo
 * - 文件列表：GET https://pan.baidu.com/rest/2.0/xpan/file?method=list
 * - 文件元信息：GET https://pan.baidu.com/rest/2.0/xpan/multimedia?method=filemetas
 * - 下载直链：从 filemetas 返回的 dlink 拼接 access_token
 * - 刷新令牌：POST https://openapi.baidu.com/oauth/2.0/token
 *
 * 注意：百度网盘下载直链 dlink 需要拼接 &access_token=xxx 才能直接下载。
 * 普通用户下载速度受限，SVIP 用户可满速。
 */

const https = require('https');
const { URL } = require('url');
const CloudDriveBase = require('./base');

const API_BASE = 'https://pan.baidu.com';
const USER_AGENT = 'pan.baidu.com;netdisk;11.6.3;android-android;11';

class BaiduDriver extends CloudDriveBase {
  constructor(account) {
    super(account);
    this.accessToken = account.access_token || '';
    this.refreshToken = account.refresh_token || '';
    this._cache = {
      files: new Map(),
      urls: new Map(),
    };
    this._cacheTTL = 2 * 60 * 1000;
  }

  // ==================== HTTP 工具 ====================

  async _request(method, path, params = {}, body = null) {
    // 百度网盘 API 用 query 参数传 access_token
    const url = new URL(API_BASE + path);
    url.searchParams.set('access_token', this.accessToken);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }

    return new Promise((resolve, reject) => {
      const options = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method,
        headers: {
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error_code) {
              reject(new Error(`Baidu API error: ${json.error_code} - ${json.error_msg || 'unknown'}`));
            } else {
              resolve(json);
            }
          } catch (e) {
            resolve(data);
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Baidu API timeout')); });

      if (body) req.write(body);
      req.end();
    });
  }

  // ==================== 认证相关 ====================

  async getQRCode() {
    throw new Error('百度网盘请使用 OAuth access_token 登录');
  }

  async checkQRStatus(qrId) {
    throw new Error('not implemented');
  }

  async refreshToken() {
    if (!this.refreshToken) {
      throw new Error('百度网盘 refresh_token 为空，无法刷新');
    }

    const result = await new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: 'iYceGe1xD7fG3mRqAlZtE2q6GGiMo09f', // 百度网盘官方 App client_id
        client_secret: 'Xb0j0E8j0q0V0q0X0j0E8j0q0V0q0X0',
      });

      const req = https.request({
        hostname: 'openapi.baidu.com',
        port: 443,
        path: '/oauth/2.0/token?' + params.toString(),
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });

    if (result.access_token) {
      this.accessToken = result.access_token;
      this.refreshToken = result.refresh_token || this.refreshToken;
      return {
        accessToken: result.access_token,
        refreshToken: result.refresh_token || this.refreshToken,
        expiresAt: new Date(Date.now() + (result.expires_in || 2592000) * 1000),
      };
    }
    throw new Error('百度网盘 token 刷新失败: ' + (result.error_description || 'unknown'));
  }

  // ==================== 文件操作 ====================

  async listFiles(remotePath) {
    const normalized = this._normalizePath(remotePath);
    const cacheKey = normalized;
    const cached = this._cache.files.get(cacheKey);
    if (cached && Date.now() < cached.expireAt) {
      return cached.data;
    }

    const allFiles = [];
    let start = 0;
    const limit = 1000;

    while (true) {
      const result = await this._request('GET', '/rest/2.0/xpan/file', {
        method: 'list',
        dir: normalized,
        start,
        limit,
        order: 'name',
        desc: 0,
      });

      if (result.list && result.list.length > 0) {
        allFiles.push(...result.list);
        if (result.list.length < limit) break;
        start += limit;
      } else {
        break;
      }
    }

    const files = allFiles.map(item => ({
      fileId: String(item.fs_id),
      name: item.server_filename,
      path: item.path,
      isDir: item.isdir === 1,
      size: item.size || 0,
      modifiedAt: item.server_mtime ? new Date(item.server_mtime * 1000) : null,
      // 百度网盘用 fs_id 获取下载链接
      pickCode: String(item.fs_id),
    }));

    this._cache.files.set(cacheKey, { data: files, expireAt: Date.now() + this._cacheTTL });
    return files;
  }

  async getFileInfo(fileId) {
    const result = await this._request('GET', '/rest/2.0/xpan/multimedia', {
      method: 'filemetas',
      fsids: `[${fileId}]`,
      dlink: 1,
    });
    return result;
  }

  async getDownloadUrl(fileId) {
    // 检查缓存
    const cached = this._cache.urls.get(fileId);
    if (cached && Date.now() < cached.expireAt) {
      return cached.data;
    }

    const result = await this._request('GET', '/rest/2.0/xpan/multimedia', {
      method: 'filemetas',
      fsids: `[${fileId}]`,
      dlink: 1,
    });

    let dlink = '';
    if (result.list && result.list.length > 0) {
      dlink = result.list[0].dlink || '';
    }

    if (!dlink) {
      throw new Error(`百度网盘获取下载链接失败: fileId=${fileId}`);
    }

    // 百度网盘 dlink 需要拼接 access_token 才能直接下载
    const url = dlink + '&access_token=' + this.accessToken;
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000); // 8小时有效

    const data = { url, expiresAt };
    this._cache.urls.set(fileId, { data, expireAt: expiresAt.getTime() - 60000 });
    return data;
  }

  // ==================== 上传相关 ====================

  async mkdir(remotePath) {
    const normalized = this._normalizePath(remotePath);
    const result = await this._request('POST', '/rest/2.0/xpan/file', {
      method: 'create',
      path: normalized,
      isdir: 1,
    });
    return String(result.fs_id);
  }

  async uploadFile(localPath, remotePath, onProgress) {
    throw new Error('百度网盘上传暂未实现（需要分片上传逻辑）');
  }

  // ==================== 工具 ====================

  async getUserInfo() {
    const result = await this._request('GET', '/rest/2.0/xpan/nas', {
      method: 'uinfo',
    });

    return {
      nickname: result.uname || '百度网盘用户',
      totalSize: result.total || 0,
      usedSize: result.used || 0,
      avatar: result.avatar_url || '',
      vip_type: result.vip_type,
    };
  }
}

module.exports = BaiduDriver;
