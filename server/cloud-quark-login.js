/**
 * 夸克网盘扫码登录模块
 * 实现夸克网盘扫码登录，获取 cookie 后自动添加到 Alist
 *
 * 流程：
 * 1. 获取二维码 token
 * 2. 生成二维码图片（前端用 qrcode.js 或后端生成 base64）
 * 3. 轮询扫码状态
 * 4. 扫码确认后获取 cookie
 * 5. 通过 Alist API 创建 Quark 存储
 */

const express = require('express');
const router = express.Router();
const https = require('https');
const http = require('http');

const QUARK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Quark/1.0';

// 内存中保存扫码会话
const qrSessions = new Map();

let _db = null;
let _alistUrl = 'http://localhost:5234';
let _alistToken = null;
let _alistTokenExpiry = 0;

/**
 * 初始化模块
 */
function init(db, alistUrl) {
  _db = db;
  _alistUrl = alistUrl || process.env.ALIST_URL || 'http://localhost:5234';
  return router;
}

/**
 * 发起 HTTPS GET 请求
 */
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': QUARK_UA,
        'Accept': 'application/json, text/plain, */*',
        ...headers
      }
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf-8')
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('请求超时')));
    req.end();
  });
}

/**
 * Alist 登录获取 token
 */
async function alistLogin() {
  const password = process.env.ALIST_ADMIN_PASSWORD || 'admin123';
  const body = JSON.stringify({ username: 'admin', password });

  const result = await new Promise((resolve, reject) => {
    const urlObj = new URL(_alistUrl);
    const req = http.request(_alistUrl + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          if (r.code === 200 && r.data && r.data.token) {
            resolve(r.data.token);
          } else {
            reject(new Error('Alist 登录失败: ' + (r.message || data)));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  _alistToken = result;
  _alistTokenExpiry = Date.now() + 47 * 3600 * 1000;
  return result;
}

/**
 * 获取有效的 Alist token
 */
async function getAlistToken() {
  if (_alistToken && Date.now() < _alistTokenExpiry) return _alistToken;
  return await alistLogin();
}

/**
 * 调用 Alist API
 */
async function alistApi(method, apiPath, body = null) {
  const token = await getAlistToken();
  const url = _alistUrl + apiPath;
  const bodyStr = body ? JSON.stringify(body) : null;

  const result = await new Promise((resolve, reject) => {
    const headers = { 'Authorization': token };
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = http.request(url, { method, headers, timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          reject(new Error('Alist API 响应解析失败'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Alist API 超时')));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });

  return result.data;
}

// ============ API 路由 ============

/**
 * GET /api/quark/qrcode/generate
 * 生成夸克登录二维码
 */
router.get('/qrcode/generate', async (req, res) => {
  try {
    console.log('[QuarkLogin] 生成扫码登录二维码');

    const t = Date.now();
    const result = await httpsGet(
      `https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin?client_id=532&v=1.2&request_id=${t}`,
      { 'Referer': 'https://pan.quark.cn/' }
    );

    const data = JSON.parse(result.body);
    const token = data.data.members.token;

    // 二维码内容
    const qrContent = `https://su.quark.cn/4_eMHBJ?token=${token}&client_id=532&ssb=weblogin&uc_param_str=&uc_biz_str=S%3Acustom%7COPT%3ASAREA%400%7COPT%3AIMMERSIVE%401%7COPT%3ABACK_BTN_STYLE%400`;

    // 保存会话
    qrSessions.set(token, {
      token,
      createdAt: Date.now(),
      status: 'waiting',
      cookie: null,
      nickname: null
    });

    console.log('[QuarkLogin] 二维码生成成功, token:', token.substring(0, 20) + '...');

    res.json({
      success: true,
      sessionId: token,
      qrContent: qrContent,  // 前端用 qrcode.js 生成二维码
      message: '请用夸克App扫码登录'
    });
  } catch (error) {
    console.error('[QuarkLogin] 生成二维码失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/quark/qrcode/status?token=xxx
 * 轮询扫码状态
 */
router.get('/qrcode/status', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) {
      return res.status(400).json({ error: '缺少 token 参数' });
    }

    const t = Date.now();
    const result = await httpsGet(
      `https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken?client_id=532&v=1.2&token=${token}&request_id=${t}`,
      { 'Referer': 'https://pan.quark.cn/' }
    );

    const data = JSON.parse(result.body);
    const status = data.status;

    let loginStatus = 'waiting';
    let cookie = null;
    let nickname = null;

    if (status === 2000000) {
      // 扫码成功
      loginStatus = 'confirmed';
      const ticket = data.data.members.service_ticket;

      // 获取 cookie
      try {
        cookie = await fetchQuarkCookie(ticket);
        if (cookie) {
          // 获取用户昵称
          nickname = await fetchQuarkNickname(cookie);
          const session = qrSessions.get(token);
          if (session) {
            session.status = 'confirmed';
            session.cookie = cookie;
            session.nickname = nickname;
          }
        }
      } catch (e) {
        console.error('[QuarkLogin] 获取 cookie 失败:', e.message);
      }
    } else if (status === 50004001) {
      loginStatus = 'waiting'; // 等待扫码
    } else if (status === 50004002) {
      loginStatus = 'expired'; // 二维码过期
    } else {
      console.warn('[QuarkLogin] 未知状态:', status, data.message);
    }

    res.json({
      success: true,
      status: loginStatus,
      rawStatus: status,
      cookie: cookie,
      nickname: nickname,
      message: data.message
    });
  } catch (error) {
    console.error('[QuarkLogin] 检查扫码状态失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 通过 service ticket 获取夸克 cookie
 */
async function fetchQuarkCookie(ticket) {
  // 第一步：访问 account/info 获取初始 cookie
  const result1 = await httpsGet(
    `https://pan.quark.cn/account/info?st=${ticket}&lw=scan`,
    { 'Referer': 'https://pan.quark.cn/' }
  );

  const setCookie1 = result1.headers['set-cookie'] || [];

  // 解析昵称
  let nickname = '';
  try {
    const data1 = JSON.parse(result1.body);
    nickname = data1.data?.nickname || '';
  } catch (e) {}

  // 第二步：访问 drive-pc 获取完整 cookie
  const cookieStr = cookiesToString(setCookie1);
  const result2 = await httpsGet(
    'https://drive-pc.quark.cn/1/clouddrive/config?pr=ucpro&fr=pc&uc_param_str=',
    {
      'Referer': 'https://pan.quark.cn/',
      'Cookie': cookieStr
    }
  );

  const setCookie2 = result2.headers['set-cookie'] || [];
  const allCookies = [...setCookie1, ...setCookie2];

  return cookiesToString(allCookies);
}

/**
 * 获取夸克用户昵称
 */
async function fetchQuarkNickname(cookie) {
  try {
    const result = await httpsGet(
      'https://pan.quark.cn/account/info',
      {
        'Referer': 'https://pan.quark.cn/',
        'Cookie': cookie
      }
    );
    const data = JSON.parse(result.body);
    return data.data?.nickname || '';
  } catch (e) {
    return '';
  }
}

/**
 * 把 Set-Cookie 数组合并成字符串
 */
function cookiesToString(setCookies) {
  const map = new Map();
  for (const sc of setCookies) {
    const pair = sc.split(';')[0];
    const idx = pair.indexOf('=');
    if (idx > 0) {
      const key = pair.substring(0, idx).trim();
      const value = pair.substring(idx + 1).trim();
      map.set(key, value);
    }
  }
  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * POST /api/quark/apply
 * 将夸克 cookie 添加到 Alist
 * Body: { cookie: '...', nickname: '...', mountPath: '/夸克网盘' }
 */
router.post('/apply', async (req, res) => {
  try {
    const { cookie, nickname, mountPath } = req.body;
    if (!cookie) {
      return res.status(400).json({ error: 'cookie 不能为空' });
    }

    const mount = mountPath || '/🍒夸克网盘/' + (nickname || 'quark');

    // 检查是否已存在
    const storages = await alistApi('GET', '/api/admin/storage/list');
    if (storages.code === 200) {
      for (const s of storages.data.content || []) {
        if (s.mount_path === mount) {
          // 更新已有存储
          const addition = JSON.stringify({
            cookie: cookie,
            root_folder_id: '0',
            order_by: 'name',
            order_direction: 'ASC',
            rapid_to_guangya: false
          });
          await alistApi('POST', '/api/admin/storage/update', {
            id: s.id,
            mount_path: mount,
            order: s.order || 100,
            driver: 'Quark',
            cache_expiration: 30,
            status: 'work',
            addition: addition,
          });
          return res.json({ success: true, message: '夸克网盘已更新', mountPath: mount });
        }
      }
    }

    // 创建新存储
    const addition = JSON.stringify({
      cookie: cookie,
      root_folder_id: '0',
      order_by: 'name',
      order_direction: 'ASC',
      rapid_to_guangya: false
    });

    const result = await alistApi('POST', '/api/admin/storage/create', {
      mount_path: mount,
      order: 100,
      driver: 'Quark',
      cache_expiration: 30,
      status: 'work',
      addition: addition,
    });

    if (result.code === 200) {
      res.json({ success: true, message: '夸克网盘添加成功', mountPath: mount });
    } else {
      res.status(500).json({ error: 'Alist 添加存储失败: ' + (result.message || JSON.stringify(result)) });
    }
  } catch (error) {
    console.error('[QuarkLogin] 添加到 Alist 失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/quark/status
 * 查看已配置的夸克网盘
 */
router.get('/status', async (req, res) => {
  try {
    const storages = await alistApi('GET', '/api/admin/storage/list');
    if (storages.code !== 200) {
      return res.json({ success: true, data: [] });
    }

    const quarkStorages = (storages.data.content || []).filter(s =>
      s.driver === 'Quark' || s.driver === 'quark'
    ).map(s => ({
      id: s.id,
      mountPath: s.mount_path,
      status: s.status,
      driver: s.driver,
      modified: s.modified
    }));

    res.json({ success: true, data: quarkStorages });
  } catch (error) {
    console.error('[QuarkLogin] 查询状态失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = { init, router };
