/**
 * 夸克网盘（Quark）驱动
 *
 * 认证方式：Cookie 登录（网页端扫码 / 手动粘贴 Cookie）
 *   - access_token: 完整 Cookie 字符串（含 kpsdk_uname / kpsdk_sid / __puus / __puus_nb 等）
 *
 * 核心 API（端点从 gbox-alist-tvbox（Java）项目提取）：
 *   - 扫码取 token：GET https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin?client_id=532&v=1.2&request_id={ts}
 *   - 轮询扫码状态：GET https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken?client_id=532&v=1.2&token={token}&request_id={ts}
 *       status=2000000 已确认 -> service_ticket -> 用 st 换 Cookie
 *       status=50004001 等待扫码, 50004002 二维码过期
 *   - st 换 Cookie：GET https://pan.quark.cn/account/info?st={ticket}&lw=scan （读 Set-Cookie）
 *   - 补齐 Cookie：GET https://drive-pc.quark.cn/1/clouddrive/config?pr=ucpro&fr=pc&uc_param_str=
 *   - 用户信息：GET https://drive-pc.quark.cn/1/clouddrive/member?pr=ucpro&fr=pc&...
 *              GET https://pan.quark.cn/account/info?fr=pc&platform=pc
 *   - 文件列表：POST https://drive-pc.quark.cn/1/clouddrive/file/sort?pr=ucpro&fr=pc&uc_param_str=
 *   - 下载直链：POST https://drive-pc.quark.cn/1/clouddrive/file/download?pr=ucpro&fr=pc&uc_param_str=
 *
 * 关键设计：
 *   - 网盘内用 fid（文件/目录ID）寻址，路径逐层 list 解析为 fid（带缓存）
 *   - 下载直链签名可能与 UA 绑定：getDownloadUrlByPath(path, clientUA) 必须透传客户端 UA，
 *     直链 URL 缓存 key 含 UA，避免混用导致 CDN 403
 *   - 直链为夸克 CDN 的 302 直链，播放时媒体数据直连 CDN，NAS 零转发
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
// qrcode 懒加载：仅扫码登录时才需要，避免模块加载期硬依赖
const CloudDriveBase = require('./base');

// API 端点
const API = {
  qrToken: 'https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin',
  qrStatus: 'https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken',
  accountInfo: 'https://pan.quark.cn/account/info',
  driveConfig: 'https://drive-pc.quark.cn/1/clouddrive/config',
  member: 'https://drive-pc.quark.cn/1/clouddrive/member',
  fileSort: 'https://drive-pc.quark.cn/1/clouddrive/file/sort',
  fileDownload: 'https://drive-pc.quark.cn/1/clouddrive/file/download',
};

// 与夸克 PC 客户端一致的 UA（drive-pc API 要求）
const QUARK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch';

// 扫码二维码内容（gbox 项目使用的固定短链模板）
const QR_CONTENT_TPL = 'https://su.quark.cn/4_eMHBJ?token={token}&client_id=532&ssb=weblogin&uc_param_str=&uc_biz_str=S%3Acustom%7COPT%3ASAREA%400%7COPT%3AIMMERSIVE%401%7COPT%3ABACK_BTN_STYLE%400';

class QuarkDriver extends CloudDriveBase {
  constructor(account) {
    super(account);
    // access_token 存完整 Cookie 字符串
    this.cookie = account.access_token || '';
    // base 构造函数会把 this.refreshToken 设为实例字段，遮蔽原型上的 refreshToken() 方法。
    // 夸克为 Cookie 登录、不需要 refresh_token 凭据，删除该自有属性，让 refreshToken() 方法可被调用。
    delete this.refreshToken;
    this._cache = {
      files: new Map(),   // path -> 文件列表
      urls: new Map(),    // `${fid}|${ua}` -> 直链
      fidPaths: new Map(), // path -> fid
    };
    this._cacheTTL = 2 * 60 * 1000;
  }

  // ==================== 内部 HTTP 工具 ====================

  /**
   * 通用 JSON 请求
   * @param {string} method
   * @param {string} url
   * @param {object} [opts] { body, headers, useClientUA }
   *   useClientUA: 调用方传入的客户端 UA，用于覆盖默认 QUARK_UA（下载直链签名与 UA 绑定时使用）
   * @returns {Promise<{status:number, headers:object, body:object}>}
   */
  async _request(method, url, opts = {}) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? https : http;

      const headers = {
        'User-Agent': opts.clientUA || QUARK_UA,
        'Accept': 'application/json, text/plain, */*',
        ...(opts.headers || {}),
      };

      // 需要登录态的请求自动带 Cookie
      if (this.cookie && opts.sendCookie !== false) {
        headers['Cookie'] = this.cookie;
      }

      let bodyPayload = null;
      if (opts.body !== undefined && opts.body !== null) {
        bodyPayload = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(bodyPayload);
      }

      const req = lib.request({
        method,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers,
        timeout: opts.timeout || 30000,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            const json = JSON.parse(raw);
            resolve({ status: res.statusCode, headers: res.headers, body: json, raw });
          } catch (e) {
            resolve({ status: res.statusCode, headers: res.headers, body: raw, raw });
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Quark API timeout')); });

      if (bodyPayload) req.write(bodyPayload);
      req.end();
    });
  }

  /**
   * 从 Set-Cookie 响应头中拼接 "k=v; k=v" 形式的 Cookie
   */
  _mergeSetCookies(existing, setCookieHeaders) {
    const map = new Map();
    // 先放入已有 Cookie
    if (existing) {
      for (const part of existing.split(';')) {
        const kv = part.trim();
        const eq = kv.indexOf('=');
        if (eq > 0) map.set(kv.slice(0, eq), kv.slice(eq + 1));
      }
    }
    // 叠加新下发的 Cookie
    if (Array.isArray(setCookieHeaders)) {
      for (const sc of setCookieHeaders) {
        const first = sc.split(';')[0].trim();
        const eq = first.indexOf('=');
        if (eq > 0) map.set(first.slice(0, eq), first.slice(eq + 1));
      }
    }
    return Array.from((map)).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  // ==================== 认证：扫码登录 ====================

  /**
   * 获取扫码登录二维码
   * 流程：uop.quark.cn 取 token -> 生成二维码内容 -> 渲染成 base64 PNG
   * @returns {Promise<{qrId:string, qrImage:string, expiresIn:number}>}
   */
  async getQRCode() {
    const t = Date.now();
    const res = await this._request('GET',
      `${API.qrToken}?client_id=532&v=1.2&request_id=${t}`,
      { sendCookie: false });

    const token = res.body && res.body.data && res.body.data.members && res.body.data.members.token;
    if (!token) {
      throw new Error('夸克获取扫码 token 失败: ' + JSON.stringify(res.body).slice(0, 200));
    }

    const qrContent = QR_CONTENT_TPL.replace('{token}', encodeURIComponent(token));
    // qrImage 为 data:image/png;base64,... 前端可直接 <img> 展示（qrcode 包为运行时依赖）
    const QRCode = require('qrcode');
    const qrImage = await QRCode.toDataURL(qrContent, { width: 320, margin: 1 });

    return {
      qrId: token,
      qrImage,
      expiresIn: 180,
    };
  }

  /**
   * 轮询扫码状态
   * status=2000000 已确认：用 service_ticket 换取完整 Cookie
   * @param {string} qrId - getQRCode 返回的 token
   */
  async checkQRStatus(qrId) {
    const t = Date.now();
    let res;
    try {
      res = await this._request('GET',
        `${API.qrStatus}?client_id=532&v=1.2&token=${encodeURIComponent(qrId)}&request_id=${t}`,
        { sendCookie: false });
    } catch (e) {
      // 网络抖动：按“等待扫码”处理，前端继续轮询
      return { status: 'waiting' };
    }

    const json = res.body || {};
    const status = json.status;

    if (status === 50004002) {
      return { status: 'expired' };
    }
    if (status !== 2000000) {
      // 50004001 = 等待扫码；其它未知状态一律按等待处理
      return { status: 'waiting' };
    }

    const ticket = json.data && json.data.members && json.data.members.service_ticket;
    if (!ticket) {
      return { status: 'waiting' };
    }

    // 1) 用 st 换取第一组 Cookie（pan.quark.cn）
    let cookie = '';
    let nickname = '';
    try {
      const infoRes = await this._request('GET',
        `${API.accountInfo}?st=${encodeURIComponent(ticket)}&lw=scan`,
        { sendCookie: false, headers: { 'Referer': 'https://pan.quark.cn' } });
      cookie = this._mergeSetCookies(cookie, infoRes.headers['set-cookie']);
      if (infoRes.body && infoRes.body.data && infoRes.body.data.nickname) {
        nickname = infoRes.body.data.nickname;
      }
    } catch (e) {
      throw new Error('夸克换取 service_ticket 失败: ' + e.message);
    }

    // 2) 用第一组 Cookie 调 drive config，补齐 kpsdk_sid 等驱动 Cookie
    try {
      const cfgRes = await this._request('GET',
        `${API.driveConfig}?pr=ucpro&fr=pc&uc_param_str=`,
        { sendCookie: false, headers: { 'Cookie': cookie, 'Referer': 'https://pan.quark.cn' } });
      cookie = this._mergeSetCookies(cookie, cfgRes.headers['set-cookie']);
    } catch (e) {
      // config 失败不致命，第一组 Cookie 通常已可用
      console.warn('[Quark] 补齐 drive config Cookie 失败:', e.message);
    }

    if (!cookie) {
      throw new Error('夸克扫码确认后未获取到 Cookie');
    }

    // 登录成功，驱动实例立即更新 cookie，便于后续 getUserInfo 复用
    this.cookie = cookie;
    if (nickname) this._nickname = nickname;

    return {
      status: 'confirmed',
      tokens: {
        access_token: cookie,
        refresh_token: '', // Cookie 类登录无 refresh_token
        expires_in: 86400 * 30, // 约 30 天
      },
    };
  }

  /**
   * 刷新 Token（夸克为 Cookie 登录，不支持主动刷新，返回当前 Cookie）
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
   * 路径解析为目录 fid（根目录 parent_fid = "0"）
   */
  async _pathToParentFid(remotePath) {
    const normalized = this._normalizePath(remotePath);
    if (normalized === '/') return '0';

    const cached = this._cache.fidPaths.get(normalized);
    if (cached && Date.now() < cached.expireAt) return cached.data;

    const parts = normalized.split('/').filter(Boolean);
    let parentFid = '0';
    for (const part of parts) {
      const files = await this._listByParentFid(parentFid);
      const dir = files.find(f => f.isDir && f.name === part);
      if (!dir) {
        throw new Error(`夸克网盘目录不存在: ${normalized}（缺少: ${part}）`);
      }
      parentFid = dir.fileId;
    }

    this._cache.fidPaths.set(normalized, { data: parentFid, expireAt: Date.now() + this._cacheTTL });
    return parentFid;
  }

  /**
   * 按 parent_fid 列出目录内容（自动分页）
   */
  async _listByParentFid(parentFid) {
    const all = [];
    let page = 1;
    const size = 200;
    // 安全上限，防止异常返回死循环
    for (let guard = 0; guard < 50; guard++) {
      const res = await this._request('POST',
        `${API.fileSort}?pr=ucpro&fr=pc&uc_param_str=`,
        {
          body: {
            parent_fid: parentFid,
            _page: page,
            _size: size,
            _fetch_subscribed: false,
            _fetch_share: true,
            _sort: 'file_type:asc,file_name:asc',
          },
          headers: { 'Referer': 'https://pan.quark.cn/' },
        });

      const data = res.body && res.body.data;
      if (!data) {
        throw new Error('夸克列目录失败: ' + JSON.stringify(res.body).slice(0, 200));
      }
      const meta = data.metadata || [];
      for (const item of meta) {
        all.push(this._normalizeItem(item));
      }
      const pag = data.pagginate || {};
      const hasMore = pag.has_more === true || pag.has_more === 1;
      if (!hasMore || meta.length === 0) break;
      page++;
    }
    return all;
  }

  /**
   * 把夸克原始 item 转成统一文件结构
   */
  _normalizeItem(item) {
    const dirFlag = item.dir === true || item.dir === '1' || item.dir === 1;
    const modifiedTs = parseInt(item.modified_at || item.updated_at || '0', 10);
    return {
      fileId: String(item.fid || ''),
      name: item.file_name || item.name || '',
      path: '', // 由 listFiles 补全
      isDir: dirFlag,
      size: parseInt(item.size || '0', 10),
      modifiedAt: modifiedTs ? new Date(modifiedTs * 1000) : new Date(),
      sha1: item.sha1,
      category: item.category,
    };
  }

  /**
   * 列出目录下的文件和子目录
   */
  async listFiles(remotePath) {
    const normalized = this._normalizePath(remotePath);

    const cached = this._cache.files.get(normalized);
    if (cached && Date.now() < cached.expireAt) return cached.data;

    const parentFid = await this._pathToParentFid(normalized);
    const items = await this._listByParentFid(parentFid);

    const result = items.map((it) => ({
      ...it,
      path: this._joinPath(normalized, it.name),
    }));

    this._cache.files.set(normalized, { data: result, expireAt: Date.now() + this._cacheTTL });
    return result;
  }

  /**
   * 获取文件详情（夸克无独立详情接口，按名称在父目录中查找）
   */
  async getFileInfo(fileId) {
    throw new Error('夸克网盘无独立文件详情接口，请用 listFiles 查找');
  }

  /**
   * 获取下载直链（支持 Range 的 CDN 直链，单层 302 即可播放）
   * @param {string} fileId - 文件 fid
   * @param {string} [clientUA] - 客户端 UA。夸克 CDN 直链签名可能与调用下载 API 时的 UA 绑定，
   *   必须透传客户端（VLC/浏览器/TV）UA，否则可能 403。
   */
  async getDownloadUrl(fileId, clientUA) {
    const cacheKey = clientUA ? `${fileId}|${clientUA}` : fileId;
    const cached = this._cache.urls.get(cacheKey);
    if (cached && Date.now() < cached.expireAt) return cached.data;

    const res = await this._request('POST',
      `${API.fileDownload}?pr=ucpro&fr=pc&uc_param_str=`,
      {
        body: { fids: [String(fileId)] },
        headers: { 'Referer': 'https://pan.quark.cn/' },
        clientUA: clientUA || undefined,
      });

    const data = res.body && res.body.data;
    const first = Array.isArray(data) ? data[0] : (data && data.list && data.list[0]);
    const url = first && (first.download_url || first.url);
    if (!url) {
      throw new Error('夸克获取下载直链失败: ' + JSON.stringify(res.body).slice(0, 200));
    }

    // 直链通常数小时有效；提前 5 分钟失效作为安全边界
    const ttl = 2 * 3600 * 1000;
    const result = { url, expiresAt: new Date(Date.now() + ttl) };
    this._cache.urls.set(cacheKey, { data: result, expireAt: Date.now() + ttl - 5 * 60 * 1000 });
    return result;
  }

  /**
   * 通过文件路径获取下载直链
   * @param {string} filePath - 文件完整路径
   * @param {string} [clientUA] - 客户端 UA，透传给 getDownloadUrl 使签名匹配
   */
  async getDownloadUrlByPath(filePath, clientUA) {
    const normalized = this._normalizePath(filePath);
    const dir = this._dirname(normalized);
    const name = this._basename(normalized);

    const files = await this.listFiles(dir);
    const file = files.find(f => f.name === name && !f.isDir);
    if (!file) {
      throw new Error(`夸克文件不存在: ${normalized}`);
    }
    return this.getDownloadUrl(file.fileId, clientUA);
  }

  // ==================== 上传/目录操作 ====================

  async mkdir(remotePath) {
    // 夸克 mkdir 需要专门的新建目录 API，当前 KTV 场景仅读取播放，暂不实现
    throw new Error('夸克网盘 mkdir 暂未实现');
  }

  async uploadFile(localPath, remotePath, onProgress) {
    throw new Error('夸克网盘上传暂未实现');
  }

  // ==================== 工具方法 ====================

  /**
   * 用户信息：昵称 + 容量
   */
  async getUserInfo() {
    const headers = { 'Referer': 'https://pan.quark.cn/' };

    let nickname = this._nickname || '';
    let totalSize = 0;
    let usedSize = 0;
    let vip = '';

    try {
      const mem = await this._request('GET',
        `${API.member}?pr=ucpro&fr=pc&uc_param_str=&fetch_subscribe=true&_ch=home&fetch_identity=true`,
        { headers });
      const md = mem.body && mem.body.data;
      if (md) {
        totalSize = parseInt(md.total_capacity || '0', 10);
        usedSize = parseInt(md.use_capacity || '0', 10);
        vip = md.member_type || '';
      }
    } catch (e) {
      console.warn('[Quark] 获取会员/容量失败:', e.message);
    }

    try {
      const info = await this._request('GET', `${API.accountInfo}?fr=pc&platform=pc`, { headers });
      if (info.body && info.body.data && info.body.data.nickname) {
        nickname = info.body.data.nickname;
      }
      if (info.body && info.body.data && !totalSize) {
        totalSize = parseInt(info.body.data.total_capacity || '0', 10);
        usedSize = parseInt(info.body.data.use_capacity || '0', 10);
      }
    } catch (e) {
      console.warn('[Quark] 获取昵称失败:', e.message);
    }

    return {
      nickname: nickname || '夸克用户',
      totalSize,
      usedSize,
      vip,
    };
  }

  /**
   * 测试连接
   */
  async testConnection() {
    try {
      const info = await this.getUserInfo();
      if (!this.cookie) throw new Error('Cookie 为空');
      if (info && !info.nickname) throw new Error('无法获取用户信息，Cookie 可能已失效');
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // ==================== 路径工具 ====================

  _normalizePath(path) {
    if (!path || path === '') return '/';
    if (!path.startsWith('/')) path = '/' + path;
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

module.exports = QuarkDriver;
