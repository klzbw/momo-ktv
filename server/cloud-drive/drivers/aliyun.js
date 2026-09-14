/**
 * 阿里云盘驱动（Open 平台）
 *
 * 认证：通过 g-box TV OAuth 流程拿到长期 refresh_token（openToken）。
 *   - refresh_token：g-box /api/get_tokens 返回的长期令牌（存 cloud_accounts.refresh_token）
 *   - access_token：调用 g-box /api/oauth/alipan/token 用 refresh_token 换得，约 2 小时有效
 *
 * 核心 API（openapi.alipan.com，开放平台 openFile 系列）：
 * - 用户信息：POST /adrive/v1.0/user/getDriveInfo
 * - 文件列表：POST /adrive/v1.0/openFile/list
 * - 文件信息：POST /adrive/v1.0/openFile/get
 * - 下载直链：POST /adrive/v1.0/openFile/getDownloadUrl
 */

const https = require('https');
const { URL } = require('url');
const CloudDriveBase = require('./base');
const gbox = require('../gbox');

const API_BASE = 'https://openapi.alipan.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

class AliyunDriver extends CloudDriveBase {
  constructor(account) {
    super(account);
    // base.js 把 this.refreshToken 设成了字符串，会遮蔽同名方法，删除后走原型方法
    delete this.refreshToken;
    this.accessToken = account.access_token || '';
    this._refreshToken = account.refresh_token || '';
    this._driveId = null;
    this._cache = {
      files: new Map(),
      urls: new Map(),
    };
    this._cacheTTL = 2 * 60 * 1000;
  }

  // ==================== HTTP 工具 ====================

  async _request(method, path, body = null) {
    const url = new URL(API_BASE + path);
    const doCall = (token) => new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, json: JSON.parse(data) }); }
          catch (e) { resolve({ status: res.statusCode, json: null, raw: data }); }
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Aliyun API timeout')); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });

    let token = this.accessToken;
    if (!token) {
      await this.refreshToken();
      token = this.accessToken;
    }
    let r = await doCall(token);
    // access_token 失效/无法校验则刷新后重试一次（含历史遗留的旧 token）
    const code = r.json && (r.json.code || r.json.error);
    const msg = (r.json && (r.json.message || r.json.error_description)) || '';
    if (r.status === 401 || /AccessTokenInvalid|TokenVerifyFailed|invalid access_token|invalid_token/i.test(String(code) + ' ' + msg)) {
      await this.refreshToken();
      r = await doCall(this.accessToken);
    }
    if (r.json && r.json.code && r.json.code !== 'OK' && r.json.code !== 200) {
      throw new Error(`Aliyun API error: ${r.json.code} - ${r.json.message || r.json.error || 'unknown'}`);
    }
    return r.json || {};
  }

  // ==================== drive_id 管理 ====================

  async _getDriveId() {
    if (this._driveId) return this._driveId;
    const info = await this.getUserInfo();
    this._driveId = info.resource_drive_id || info.default_drive_id;
    return this._driveId;
  }

  // ==================== 路径转 file_id ====================

  async _pathToFileId(remotePath) {
    const normalized = this._normalizePath(remotePath);
    if (normalized === '/') return 'root';

    const parts = normalized.split('/').filter(Boolean);
    let parentId = 'root';

    for (const part of parts) {
      const cacheKey = `${parentId}/${part}`;
      const cached = this._cache.files.get(cacheKey);
      if (cached && Date.now() < cached.expireAt) { parentId = cached.data; continue; }

      const driveId = await this._getDriveId();
      const result = await this._request('POST', '/adrive/v1.0/openFile/list', {
        drive_id: driveId,
        parent_file_id: parentId,
        limit: 200,
      });

      let found = null;
      if (result.items) found = result.items.find(item => item.name === part);

      if (!found) throw new Error(`Aliyun: path not found: ${normalized} (component: ${part})`);

      parentId = found.file_id;
      this._cache.files.set(cacheKey, { data: parentId, expireAt: Date.now() + this._cacheTTL });
    }
    return parentId;
  }

  // ==================== 认证相关 ====================

  /**
   * 扫码登录：代理到 G-Box 阿里云盘 TV OAuth 流程
   *   GET  /api/get_tv_token              -> { qr_code(base64 png), sid }
   *   GET  /api/check_qr_status?sid=..   -> { auth_code }
   *   POST /api/get_tokens               -> { refresh_token }
   */
  async getQRCode() {
    const r = await gbox.call('/api/get_tv_token', 'GET');
    if (!r.json || !r.json.qr_code || !r.json.sid) {
      throw new Error('获取阿里云盘二维码失败，请检查 G-Box 是否正常');
    }
    return {
      qrId: r.json.sid,
      qrImage: 'data:image/png;base64,' + r.json.qr_code,
      expiresIn: 300,
    };
  }

  async checkQRStatus(qrId) {
    if (!qrId) return { status: 'waiting' };
    const st = await gbox.call('/api/check_qr_status?sid=' + encodeURIComponent(qrId), 'GET');
    const authCode = st.json && st.json.auth_code;
    if (!authCode) return { status: 'waiting' };
    const tk = await gbox.call('/api/get_tokens', 'POST', { auth_code: authCode, sid: qrId });
    const refreshToken = tk.json && (tk.json.refresh_token || tk.json.access_token);
    if (!refreshToken) return { status: 'waiting' };
    // 只存长期 refresh_token；access_token 由 refreshToken() 用 g-box 换取
    return {
      status: 'confirmed',
      tokens: { access_token: '', refresh_token: refreshToken },
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
   * 用 g-box 把长期 refresh_token 换成真正的 access_token。
   * g-box: POST /api/oauth/alipan/token  body { "refresh_token": "..." }
   *        -> { access_token, refresh_token, ... }
   */
  async refreshToken() {
    if (!this._refreshToken) {
      throw new Error('阿里云盘 refresh_token 为空，无法刷新');
    }
    const r = await gbox.call('/api/oauth/alipan/token', 'POST', { refresh_token: this._refreshToken });
    const j = r.json || {};
    if (!j.access_token) {
      throw new Error('阿里云盘 token 刷新失败: ' + (j.message || r.body || 'unknown'));
    }
    this.accessToken = j.access_token;
    if (j.refresh_token) this._refreshToken = j.refresh_token;
    return {
      accessToken: j.access_token,
      refreshToken: this._refreshToken,
      expiresAt: new Date(Date.now() + (j.expires_in || 7200) * 1000),
    };
  }

  // ==================== 文件操作 ====================

  async listFiles(remotePath) {
    const parentId = await this._pathToFileId(remotePath);
    const driveId = await this._getDriveId();

    const allItems = [];
    let marker = undefined;

    do {
      const body = {
        drive_id: driveId,
        parent_file_id: parentId,
        limit: 200,
        order_by: 'name',
        order_direction: 'ASC',
      };
      if (marker) body.marker = marker;

      const result = await this._request('POST', '/adrive/v1.0/openFile/list', body);
      if (result.items) allItems.push(...result.items);
      marker = result.next_marker;
    } while (marker && marker !== '');

    return allItems.map(item => ({
      fileId: item.file_id,
      name: item.name,
      path: remotePath === '/' ? `/${item.name}` : `${remotePath}/${item.name}`,
      isDir: item.type === 'folder',
      size: item.size || 0,
      modifiedAt: item.updated_at ? new Date(item.updated_at) : null,
      pickCode: item.file_id,
    }));
  }

  async getFileInfo(fileId) {
    const driveId = await this._getDriveId();
    return this._request('POST', '/adrive/v1.0/openFile/get', {
      drive_id: driveId,
      file_id: fileId,
    });
  }

  async getDownloadUrl(fileId) {
    const cached = this._cache.urls.get(fileId);
    if (cached && Date.now() < cached.expireAt) return cached.data;

    const driveId = await this._getDriveId();
    const result = await this._request('POST', '/adrive/v1.0/openFile/getDownloadUrl', {
      drive_id: driveId,
      file_id: fileId,
    });

    const url = result.url || result.download_url || '';
    const expiresAt = result.expiration ? new Date(result.expiration) : new Date(Date.now() + 30 * 60 * 1000);

    const data = { url, expiresAt };
    this._cache.urls.set(fileId, { data, expireAt: expiresAt.getTime() - 60000 });
    return data;
  }

  async mkdir(remotePath) {
    const normalized = this._normalizePath(remotePath);
    const parts = normalized.split('/').filter(Boolean);
    const dirName = parts.pop();
    const parentPath = parts.length ? '/' + parts.join('/') : '/';
    const parentId = await this._pathToFileId(parentPath);
    const driveId = await this._getDriveId();

    const result = await this._request('POST', '/adrive/v1.0/openFile/create', {
      drive_id: driveId,
      parent_file_id: parentId,
      name: dirName,
      type: 'folder',
      check_name_mode: 'refuse',
    });
    return result.file_id;
  }

  async uploadFile() {
    throw new Error('阿里云盘上传暂未实现');
  }

  async getUserInfo() {
    const result = await this._request('POST', '/adrive/v1.0/user/getDriveInfo', {});
    return {
      nickname: result.nick_name || result.user_name || '阿里云盘用户',
      totalSize: result.total_size || 0,
      usedSize: result.used_size || 0,
      avatar: result.avatar || '',
      default_drive_id: result.default_drive_id,
      resource_drive_id: result.resource_drive_id,
    };
  }
}

module.exports = AliyunDriver;
