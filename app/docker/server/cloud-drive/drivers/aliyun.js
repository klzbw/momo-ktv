/**
 * 阿里云盘驱动
 *
 * 认证方式：Token 登录（access_token + refresh_token）
 * 获取方式：通过阿里云盘开放平台 OAuth，或从浏览器/Alist 配置中提取
 *   - access_token: 访问令牌（Bearer）
 *   - refresh_token: 刷新令牌
 *
 * 核心 API：
 * - 用户信息：GET https://api.aliyundrive.com/v2/user/get
 * - 文件列表：POST https://api.aliyundrive.com/v2/file/list
 * - 下载直链：POST https://api.aliyundrive.com/v2/file/get_download_url
 * - 刷新令牌：POST https://api.aliyundrive.com/v2/account/token
 *
 * 注意：阿里云盘需要 drive_id（资源盘ID），默认用默认资源盘。
 * 可在 account.user_info 中存储 drive_id，或自动获取。
 */

const https = require('https');
const { URL } = require('url');
const CloudDriveBase = require('./base');

const API_BASE = 'https://api.aliyundrive.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

class AliyunDriver extends CloudDriveBase {
  constructor(account) {
    super(account);
    this.accessToken = account.access_token || '';
    this.refreshToken = account.refresh_token || '';
    // drive_id 可从 user_info 中解析，或自动获取默认盘
    this._driveId = null;
    this._cache = {
      files: new Map(),
      urls: new Map(),
    };
    this._cacheTTL = 2 * 60 * 1000;
  }

  // ==================== HTTP 工具 ====================

  async _request(method, path, body = null, headers = {}) {
    const url = new URL(API_BASE + path);
    const defaultHeaders = {
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      ...headers,
    };

    return new Promise((resolve, reject) => {
      const options = {
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method,
        headers: defaultHeaders,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.code && json.code !== 'OK' && json.code !== 200) {
              reject(new Error(`Aliyun API error: ${json.code} - ${json.message || json.detail || 'unknown'}`));
            } else {
              resolve(json);
            }
          } catch (e) {
            resolve(data);
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Aliyun API timeout')); });

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  // ==================== drive_id 管理 ====================

  async _getDriveId() {
    if (this._driveId) return this._driveId;

    // 尝试从 user_info 解析
    if (this.account.user_info) {
      try {
        const info = JSON.parse(this.account.user_info);
        if (info.default_drive_id) {
          this._driveId = info.default_drive_id;
          return this._driveId;
        }
      } catch (e) { /* ignore */ }
    }

    // 自动获取默认资源盘
    const userInfo = await this._request('POST', '/v2/user/get', {});
    this._driveId = userInfo.default_drive_id || userInfo.resource_drive_id;
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
      if (cached && Date.now() < cached.expireAt) {
        parentId = cached.data;
        continue;
      }

      const result = await this._request('POST', '/v2/file/list', {
        drive_id: await this._getDriveId(),
        parent_file_id: parentId,
        limit: 200,
      });

      let found = null;
      if (result.items) {
        found = result.items.find(item => item.name === part);
      }

      if (!found) {
        throw new Error(`Aliyun: path not found: ${normalized} (component: ${part})`);
      }

      parentId = found.file_id;
      this._cache.files.set(cacheKey, { data: parentId, expireAt: Date.now() + this._cacheTTL });
    }

    return parentId;
  }

  // ==================== 认证相关 ====================

  async getQRCode() {
    throw new Error('阿里云盘请使用 Token 登录（在账号管理中填写 access_token 和 refresh_token）');
  }

  async checkQRStatus(qrId) {
    throw new Error('not implemented');
  }

  async refreshToken() {
    if (!this.refreshToken) {
      throw new Error('阿里云盘 refresh_token 为空，无法刷新');
    }

    const result = await new Promise((resolve, reject) => {
      const body = JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
      });

      const req = https.request({
        hostname: 'api.aliyundrive.com',
        port: 443,
        path: '/v2/account/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
        },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body);
      req.end();
    });

    if (result.access_token) {
      this.accessToken = result.access_token;
      this.refreshToken = result.refresh_token || this.refreshToken;
      return {
        accessToken: result.access_token,
        refreshToken: result.refresh_token || this.refreshToken,
        expiresAt: new Date(Date.now() + (result.expires_in || 7200) * 1000),
      };
    }
    throw new Error('阿里云盘 token 刷新失败: ' + (result.message || 'unknown'));
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

      const result = await this._request('POST', '/v2/file/list', body);
      if (result.items) {
        allItems.push(...result.items);
      }
      marker = result.next_marker;
    } while (marker && marker !== '');

    return allItems.map(item => ({
      fileId: item.file_id,
      name: item.name,
      path: remotePath === '/' ? `/${item.name}` : `${remotePath}/${item.name}`,
      isDir: item.type === 'folder',
      size: item.size || 0,
      modifiedAt: item.updated_at ? new Date(item.updated_at) : null,
      // 阿里云盘用 file_id 获取下载链接
      pickCode: item.file_id,
    }));
  }

  async getFileInfo(fileId) {
    const driveId = await this._getDriveId();
    return this._request('POST', '/v2/file/get', {
      drive_id: driveId,
      file_id: fileId,
    });
  }

  async getDownloadUrl(fileId) {
    // 检查缓存
    const cached = this._cache.urls.get(fileId);
    if (cached && Date.now() < cached.expireAt) {
      return cached.data;
    }

    const driveId = await this._getDriveId();
    const result = await this._request('POST', '/v2/file/get_download_url', {
      drive_id: driveId,
      file_id: fileId,
    });

    const url = result.url || result.download_url || '';
    const expiresAt = result.expiration ? new Date(result.expiration) : new Date(Date.now() + 30 * 60 * 1000);

    const data = { url, expiresAt };
    this._cache.urls.set(fileId, { data, expireAt: expiresAt.getTime() - 60000 });
    return data;
  }

  // ==================== 上传相关 ====================

  async mkdir(remotePath) {
    const normalized = this._normalizePath(remotePath);
    const parts = normalized.split('/').filter(Boolean);
    const dirName = parts.pop();
    const parentPath = parts.length ? '/' + parts.join('/') : '/';
    const parentId = await this._pathToFileId(parentPath);
    const driveId = await this._getDriveId();

    const result = await this._request('POST', '/v2/file/create', {
      drive_id: driveId,
      parent_file_id: parentId,
      name: dirName,
      type: 'folder',
      check_name_mode: 'refuse',
    });

    return result.file_id;
  }

  async uploadFile(localPath, remotePath, onProgress) {
    throw new Error('阿里云盘上传暂未实现（需要分片上传逻辑）');
  }

  // ==================== 工具 ====================

  async getUserInfo() {
    const result = await this._request('POST', '/v2/user/get', {});
    return {
      nickname: result.nick_name || result.user_name || '阿里云盘用户',
      totalSize: result.total_size || 0,
      usedSize: result.used_size || 0,
      avatar: result.avatar || '',
      default_drive_id: result.default_drive_id,
    };
  }
}

module.exports = AliyunDriver;
