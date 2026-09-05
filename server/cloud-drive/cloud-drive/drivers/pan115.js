/**
 * 115 网盘驱动
 *
 * 认证方式：扫码登录（获取 cookie: UID + CID + SEID）
 * 文件操作：webapi.115.com
 *
 * 注意事项：
 * 1. 115 直链有效期较短（几小时），播放时需实时获取
 * 2. 有并发限制，建议单账号同时下载不超过 3 个
 * 3. cookie 可能过期，需要定期检测并提示重新扫码
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const CloudDriveBase = require('./base');

class Pan115Driver extends CloudDriveBase {
  constructor(account) {
    super(account);
    // 115 用 cookie 认证，access_token 存的是 cookie 字符串
    this.cookie = account.access_token || '';
    this._userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  }

  // ==================== 内部 HTTP 工具 ====================

  _request(method, url, options = {}) {
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
   * 获取登录二维码
   * 115 网页端扫码接口
   */
  async getQRCode() {
    const res = await this._request('GET', 'https://qrcodeapi.115.com/api/1.0/web/1.0/qrcode/getqrcode/');
    if (res.body.status !== 200 && res.body.status !== true) {
      throw new Error('获取115二维码失败: ' + JSON.stringify(res.body));
    }
    const data = res.body.data;
    return {
      qrId: data.uid || data.qrcode || String(Date.now()),
      qrImage: data.qrcode || data.img, // base64 或 URL
      expiresIn: 180, // 3分钟过期
      raw: data,
    };
  }

  /**
   * 轮询扫码状态
   */
  async checkQRStatus(qrId) {
    const res = await this._request('GET', `https://qrcodeapi.115.com/api/1.0/web/1.0/qrcode/getstatus/?uid=${encodeURIComponent(qrId)}`);
    const data = res.body.data || res.body;

    // 115 返回码：0=等待扫码, 1=已扫码未确认, 2=已确认, -1=过期
    const code = data.status !== undefined ? data.status : data.code;

    if (code === 2 || data.cookie) {
      // 扫码确认成功，提取 cookie
      const cookie = data.cookie || (data.data && data.data.cookie) || '';
      // cookie 格式: UID=xxx; CID=xxx; SEID=xxx
      this.cookie = cookie;
      return {
        status: 'confirmed',
        tokens: {
          access_token: cookie,
          refresh_token: '', // 115 没有 refresh_token，cookie 过期需重新扫码
          expires_in: 86400 * 30, // 约30天
        },
      };
    } else if (code === 1) {
      return { status: 'scanned' };
    } else if (code === -1 || code === -2) {
      return { status: 'expired' };
    } else {
      return { status: 'waiting' };
    }
  }

  /**
   * 115 没有 refresh_token，cookie 过期后需要重新扫码
   * 这里尝试用 cookie 访问用户信息来验证是否过期
   */
  async refreshToken() {
    // 115 不支持 token 刷新，返回当前 cookie
    // 过期检测由 manager 调用 testConnection 完成
    return {
      accessToken: this.cookie,
      refreshToken: '',
      expiresAt: new Date(Date.now() + 86400 * 30 * 1000),
    };
  }

  // ==================== 文件操作 ====================

  /**
   * 列出目录下的文件
   * 115 用 cid（目录ID）来列目录，需要先把路径转换成 cid
   */
  async listFiles(remotePath) {
    remotePath = this._normalizePath(remotePath);

    // 根目录 cid=0
    let cid = '0';
    if (remotePath !== '/') {
      cid = await this._pathToCid(remotePath);
    }

    const res = await this._request('GET', `https://webapi.115.com/files?aid=1&cid=${cid}&limit=1000&show_dir=1`);
    if (res.body.state !== true && res.body.status !== 200) {
      throw new Error('115列目录失败: ' + JSON.stringify(res.body).slice(0, 200));
    }

    const files = res.body.data || [];
    return files.map((f) => ({
      fileId: String(f.fid || f.cid || f.id),
      name: f.n || f.name,
      path: this._joinPath(remotePath, f.n || f.name),
      isDir: f.ica === 1 || f.is_dir === 1 || f.type === 0,
      size: parseInt(f.s || f.size || 0, 10),
      modifiedAt: f.tm ? new Date(f.tm * 1000) : new Date(),
      pickCode: f.pc || f.pickcode, // 115 专用，用于获取下载直链
      fileType: f.te || f.file_type, // 文件类型
    }));
  }

  /**
   * 路径转 cid（递归查找）
   */
  async _pathToCid(remotePath) {
    const parts = remotePath.split('/').filter(Boolean);
    let cid = '0';

    for (const part of parts) {
      const res = await this._request('GET', `https://webapi.115.com/files?aid=1&cid=${cid}&limit=1000&show_dir=1`);
      const files = res.body.data || [];
      const dir = files.find((f) => (f.ica === 1 || f.is_dir === 1) && (f.n === part || f.name === part));
      if (!dir) {
        throw new Error(`115路径不存在: ${remotePath} (在 ${cid} 下找不到 "${part}")`);
      }
      cid = String(dir.cid || dir.fid || dir.id);
    }

    return cid;
  }

  /**
   * 获取文件详情
   */
  async getFileInfo(fileId) {
    // 115 没有单独的文件详情接口，用 pickCode 获取下载信息
    const res = await this._request('GET', `https://webapi.115.com/files/download?pickcode=${fileId}`);
    return res.body;
  }

  /**
   * 获取下载直链
   * @param {string} pickCode - 文件的 pickCode
   */
  async getDownloadUrl(pickCode) {
    const res = await this._request('GET', `https://webapi.115.com/files/download?pickcode=${pickCode}`);
    if (!res.body.state || !res.body.data) {
      throw new Error('115获取下载直链失败: ' + JSON.stringify(res.body).slice(0, 200));
    }

    // 115 返回多个下载地址，取第一个
    const url = res.body.data.url || res.body.data[0]?.url || res.body.url;
    return {
      url,
      expiresAt: new Date(Date.now() + 4 * 3600 * 1000), // 约4小时有效
    };
  }

  // ==================== 上传相关 ====================

  /**
   * 创建目录
   */
  async mkdir(remotePath) {
    remotePath = this._normalizePath(remotePath);
    const parts = remotePath.split('/').filter(Boolean);
    const name = parts.pop();
    const parentPath = '/' + parts.join('/');
    const parentCid = parentPath === '/' ? '0' : await this._pathToCid(parentPath);

    const res = await this._request('POST', 'https://webapi.115.com/files/add', {
      body: { pid: parentCid, cname: name },
    });

    if (!res.body.state) {
      throw new Error('115创建目录失败: ' + JSON.stringify(res.body));
    }
    return String(res.body.cid || res.body.id);
  }

  /**
   * 上传文件（简化版，大文件需要分片上传）
   */
  async uploadFile(localPath, remotePath, onProgress) {
    // 115 上传比较复杂，需要先获取上传地址，再分片上传
    // 这里先抛出未实现，后续完善
    throw new Error('115 uploadFile not implemented yet');
  }

  // ==================== 工具方法 ====================

  /**
   * 获取用户信息
   */
  async getUserInfo() {
    const res = await this._request('GET', 'https://webapi.115.com/files/userinfo');
    if (!res.body.data) {
      throw new Error('115获取用户信息失败');
    }
    const data = res.body.data;
    return {
      nickname: data.username || data.nickname,
      totalSize: parseInt(data.total_size || data.all_size || 0, 10),
      usedSize: parseInt(data.used_size || data.size || 0, 10),
      avatar: data.avatar,
      level: data.level,
    };
  }
}

module.exports = Pan115Driver;
