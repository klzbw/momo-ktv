/**
 * 移动云盘（和彩云）驱动
 *
 * 认证方式：Cookie 登录
 * 获取方式：从移动云盘网页端登录后，从浏览器开发者工具中提取 Cookie
 *   - access_token: Cookie 字符串（包含 cml_passport 等认证字段）
 *
 * 核心 API（和彩云开放接口）：
 * - 用户信息：POST https://yun.139.com/ipms/interface/v1/user/getUserInfo
 * - 文件列表：POST https://yun.139.com/ipms/interface/v1/content/listDirectory
 * - 下载直链：POST https://yun.139.com/ipms/interface/v1/content/getDownloadURL
 * - 目录ID：通过路径逐层解析（和彩云用 catalogID 而非路径）
 *
 * 注意：移动云盘 API 使用 catalogID 标识目录，contentID 标识文件。
 * 需要将路径逐层解析为 catalogID。
 * 根目录 catalogID 通常为空字符串或 "root"。
 */

const https = require('https');
const { URL } = require('url');
const CloudDriveBase = require('./base');

const API_BASE = 'https://yun.139.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

class CMCCDriver extends CloudDriveBase {
  constructor(account) {
    super(account);
    // access_token 存储 Cookie 字符串
    this.cookie = account.access_token || '';
    this._cache = {
      files: new Map(),
      urls: new Map(),
      pathIds: new Map(),
    };
    this._cacheTTL = 2 * 60 * 1000;
  }

  // ==================== HTTP 工具 ====================

  async _request(method, path, body = null, headers = {}) {
    const url = new URL(API_BASE + path);

    return new Promise((resolve, reject) => {
      const defaultHeaders = {
        'Cookie': this.cookie,
        'Content-Type': 'application/json;charset=UTF-8',
        'User-Agent': USER_AGENT,
        'Referer': 'https://yun.139.com/',
        'Origin': 'https://yun.139.com',
        ...headers,
      };

      const req = https.request({
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method,
        headers: defaultHeaders,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            // 和彩云 API 返回 { resultCode: "0", resultMsg: "success", data: {...} }
            if (json.resultCode && json.resultCode !== '0' && json.resultCode !== 0) {
              reject(new Error(`CMCC API error: ${json.resultCode} - ${json.resultMsg || 'unknown'}`));
            } else {
              resolve(json.data || json);
            }
          } catch (e) {
            resolve(data);
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('CMCC API timeout')); });

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  // ==================== 路径转 catalogID ====================

  async _pathToCatalogId(remotePath) {
    const normalized = this._normalizePath(remotePath);
    if (normalized === '/') return '';

    const cacheKey = normalized;
    const cached = this._cache.pathIds.get(cacheKey);
    if (cached && Date.now() < cached.expireAt) {
      return cached.data;
    }

    const parts = normalized.split('/').filter(Boolean);
    let catalogId = ''; // 根目录 catalogID 为空

    for (const part of parts) {
      const result = await this._request('POST', '/ipms/interface/v1/content/listDirectory', {
        parentCatalogID: catalogId,
        startNumber: 0,
        endNumber: 200,
        sortType: 1, // 按名称排序
        sortOrder: 0, // 升序
        filterType: 0, // 全部
      });

      let found = null;
      const dirList = result.catalogList || result.directoryList || [];
      found = dirList.find(d => d.catalogName === part);

      if (!found) {
        throw new Error(`CMCC: path not found: ${normalized} (component: ${part})`);
      }

      catalogId = found.catalogID;
    }

    this._cache.pathIds.set(cacheKey, { data: catalogId, expireAt: Date.now() + this._cacheTTL });
    return catalogId;
  }

  // ==================== 认证相关 ====================

  async getQRCode() {
    throw new Error('移动云盘请使用 Cookie 登录（从浏览器开发者工具提取 Cookie）');
  }

  async checkQRStatus(qrId) {
    throw new Error('not implemented');
  }

  async refreshToken() {
    // 和彩云 Cookie 有效期较长，暂不实现自动刷新
    throw new Error('移动云盘 Cookie 登录无需刷新，过期后请重新登录获取 Cookie');
  }

  // ==================== 文件操作 ====================

  async listFiles(remotePath) {
    const catalogId = await this._pathToCatalogId(remotePath);

    const allItems = [];
    let start = 0;
    const pageSize = 200;

    while (true) {
      const result = await this._request('POST', '/ipms/interface/v1/content/listDirectory', {
        parentCatalogID: catalogId,
        startNumber: start,
        endNumber: start + pageSize,
        sortType: 1,
        sortOrder: 0,
        filterType: 0,
      });

      const dirList = result.catalogList || result.directoryList || [];
      const fileList = result.contentList || result.fileList || [];

      // 目录
      for (const d of dirList) {
        allItems.push({
          fileId: d.catalogID,
          name: d.catalogName,
          path: remotePath === '/' ? `/${d.catalogName}` : `${remotePath}/${d.catalogName}`,
          isDir: true,
          size: 0,
          modifiedAt: d.updateTime ? new Date(d.updateTime) : null,
          pickCode: d.catalogID,
        });
      }

      // 文件
      for (const f of fileList) {
        allItems.push({
          fileId: f.contentID,
          name: f.contentName,
          path: remotePath === '/' ? `/${f.contentName}` : `${remotePath}/${f.contentName}`,
          isDir: false,
          size: f.fileSize || f.size || 0,
          modifiedAt: f.updateTime ? new Date(f.updateTime) : null,
          pickCode: f.contentID,
        });
      }

      if (dirList.length + fileList.length < pageSize) break;
      start += pageSize;
    }

    return allItems;
  }

  async getFileInfo(fileId) {
    return this._request('POST', '/ipms/interface/v1/content/getContentInfo', {
      contentID: fileId,
    });
  }

  async getDownloadUrl(fileId) {
    const cached = this._cache.urls.get(fileId);
    if (cached && Date.now() < cached.expireAt) {
      return cached.data;
    }

    const result = await this._request('POST', '/ipms/interface/v1/content/getDownloadURL', {
      contentID: fileId,
    });

    const url = result.downloadURL || result.url || result.downloadUrl || '';
    if (!url) {
      throw new Error(`移动云盘获取下载链接失败: fileId=${fileId}`);
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
    const parentId = await this._pathToCatalogId(parentPath);

    const result = await this._request('POST', '/ipms/interface/v1/content/createCatalog', {
      parentCatalogID: parentId,
      catalogName: dirName,
    });

    return result.catalogID;
  }

  async uploadFile(localPath, remotePath, onProgress) {
    throw new Error('移动云盘上传暂未实现');
  }

  // ==================== 工具 ====================

  async getUserInfo() {
    const result = await this._request('POST', '/ipms/interface/v1/user/getUserInfo', {});

    return {
      nickname: result.nickName || result.userName || '移动云盘用户',
      totalSize: result.totalSize || result.totalCapacity || 0,
      usedSize: result.usedSize || result.usedCapacity || 0,
      avatar: result.headPhoto || result.avatar || '',
      phone: result.phone || result.mobile || '',
    };
  }
}

module.exports = CMCCDriver;
