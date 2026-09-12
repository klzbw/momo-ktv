/**
 * 迅雷云盘驱动
 *
 * 认证方式：Bearer Token
 * 获取方式：从迅雷云盘网页端登录后，从浏览器开发者工具中提取 Authorization header
 *   - access_token: Bearer 令牌（即 Authorization: Bearer xxx 中的 xxx）
 *   - refresh_token: 刷新令牌（可选）
 *
 * 核心 API：
 * - 用户信息：GET https://api-pan.xunlei.com/drive/v1/profile
 * - 文件列表：GET https://api-pan.xunlei.com/drive/v1/files
 * - 下载直链：POST https://api-pan.xunlei.com/drive/v1/files/{file_id}/download_url
 * - 刷新令牌：POST https://api-pan.xunlei.com/drive/v1/auth/refresh (如有)
 *
 * 注意：迅雷云盘 API 风格与阿里云盘类似，使用 parent_id 而非路径。
 * 需要将路径逐层解析为 parent_id。
 */

const https = require('https');
const { URL } = require('url');
const CloudDriveBase = require('./base');

const API_BASE = 'https://api-pan.xunlei.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

class XunleiDriver extends CloudDriveBase {
  constructor(account) {
    super(account);
    this.accessToken = account.access_token || '';
    this.refreshToken = account.refresh_token || '';
    this._cache = {
      files: new Map(),
      urls: new Map(),
      pathIds: new Map(),
    };
    this._cacheTTL = 2 * 60 * 1000;
  }

  // ==================== HTTP 工具 ====================

  async _request(method, path, params = {}, body = null) {
    const url = new URL(API_BASE + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }

    return new Promise((resolve, reject) => {
      const headers = {
        'Authorization': `Bearer ${this.accessToken}`,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
      };

      const req = https.request({
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method,
        headers,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error || (json.code && json.code !== 0)) {
              reject(new Error(`Xunlei API error: ${json.error || json.code} - ${json.error_description || json.message || 'unknown'}`));
            } else {
              resolve(json);
            }
          } catch (e) {
            resolve(data);
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Xunlei API timeout')); });

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  // ==================== 路径转 parent_id ====================

  async _pathToParentId(remotePath) {
    const normalized = this._normalizePath(remotePath);
    if (normalized === '/') return 'root';

    const cacheKey = normalized;
    const cached = this._cache.pathIds.get(cacheKey);
    if (cached && Date.now() < cached.expireAt) {
      return cached.data;
    }

    const parts = normalized.split('/').filter(Boolean);
    let parentId = 'root';

    for (const part of parts) {
      const result = await this._request('GET', '/drive/v1/files', {
        parent_id: parentId,
        page_token: '',
        limit: 200,
        order: 'name',
        direction: 'asc',
      });

      let found = null;
      if (result.files) {
        found = result.files.find(f => f.name === part);
      }

      if (!found) {
        throw new Error(`Xunlei: path not found: ${normalized} (component: ${part})`);
      }

      parentId = found.id;
    }

    this._cache.pathIds.set(cacheKey, { data: parentId, expireAt: Date.now() + this._cacheTTL });
    return parentId;
  }

  // ==================== 认证相关 ====================

  /**
   * 获取迅雷云盘扫码登录二维码
   * API: POST https://api-pan.xunlei.com/drive/v1/auth/qrcode
   */
  async getQRCode() {
    const result = await this._request('POST', '/drive/v1/auth/qrcode', {}, {
      client_id: 'X',
      client_secret: 'X',
    });

    const qrId = result.qrcode_id || result.id;
    const qrUrl = result.qrcode_url || result.qr_url || result.url;

    if (!qrId || !qrUrl) {
      throw new Error('迅雷云盘获取二维码失败: ' + JSON.stringify(result));
    }

    return {
      qrId,
      qrImage: qrUrl, // 二维码图片 URL，前端直接 <img src>
      expiresIn: result.expires_in || result.expiresIn || 180,
    };
  }

  /**
   * 轮询迅雷云盘扫码状态
   * API: GET https://api-pan.xunlei.com/drive/v1/auth/qrcode/{qrcode_id}
   */
  async checkQRStatus(qrId) {
    try {
      const result = await this._request('GET', `/drive/v1/auth/qrcode/${qrId}`);
      const status = result.status || result.state;

      if (status === 'confirmed' || status === 'success') {
        return {
          status: 'confirmed',
          tokens: {
            access_token: result.access_token || result.token,
            refresh_token: result.refresh_token,
            expires_in: result.expires_in || 7200,
          },
        };
      }
      if (status === 'scanned' || status === 'scaned') return { status: 'scanned' };
      if (status === 'expired' || status === 'timeout') return { status: 'expired' };
      if (status === 'canceled') return { status: 'expired' };
      return { status: 'waiting' };
    } catch (e) {
      // 轮询期间 API 可能返回错误，按等待处理
      return { status: 'waiting' };
    }
  }

  async refreshToken() {
    if (!this.refreshToken) {
      throw new Error('迅雷云盘 refresh_token 为空，无法刷新');
    }

    try {
      const result = await this._request('POST', '/drive/v1/auth/refresh', {}, {
        refresh_token: this.refreshToken,
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
    } catch (e) {
      throw new Error('迅雷云盘 token 刷新失败: ' + e.message);
    }
    throw new Error('迅雷云盘 token 刷新失败');
  }

  // ==================== 文件操作 ====================

  async listFiles(remotePath) {
    const parentId = await this._pathToParentId(remotePath);

    const allFiles = [];
    let pageToken = '';

    do {
      const result = await this._request('GET', '/drive/v1/files', {
        parent_id: parentId,
        page_token: pageToken || undefined,
        limit: 200,
        order: 'name',
        direction: 'asc',
      });

      if (result.files) {
        allFiles.push(...result.files);
      }
      pageToken = result.next_page_token || '';
    } while (pageToken);

    return allFiles.map(item => ({
      fileId: item.id,
      name: item.name,
      path: remotePath === '/' ? `/${item.name}` : `${remotePath}/${item.name}`,
      isDir: item.kind === 'drive#folder' || item.type === 'folder',
      size: item.size || 0,
      modifiedAt: item.updated_at ? new Date(item.updated_at) : null,
      pickCode: item.id,
    }));
  }

  async getFileInfo(fileId) {
    return this._request('GET', `/drive/v1/files/${fileId}`);
  }

  async getDownloadUrl(fileId) {
    const cached = this._cache.urls.get(fileId);
    if (cached && Date.now() < cached.expireAt) {
      return cached.data;
    }

    const result = await this._request('POST', `/drive/v1/files/${fileId}/download_url`);

    const url = result.download_url || result.url || '';
    if (!url) {
      throw new Error(`迅雷云盘获取下载链接失败: fileId=${fileId}`);
    }

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
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
    const parentId = await this._pathToParentId(parentPath);

    const result = await this._request('POST', '/drive/v1/files', {}, {
      kind: 'drive#folder',
      name: dirName,
      parent_id: parentId,
    });

    return result.id;
  }

  async uploadFile(localPath, remotePath, onProgress) {
    throw new Error('迅雷云盘上传暂未实现');
  }

  // ==================== 工具 ====================

  async getUserInfo() {
    const result = await this._request('GET', '/drive/v1/profile');

    return {
      nickname: result.nickname || result.name || '迅雷云盘用户',
      totalSize: result.total_size || 0,
      usedSize: result.used_size || 0,
      avatar: result.avatar || '',
      vip: result.vip || result.member_type,
    };
  }
}

module.exports = XunleiDriver;
