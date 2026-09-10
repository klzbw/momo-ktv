/**

 * 网盘曲库集成模块入口

 * 注册 API 路由，提供网盘账号管理、文件浏览、曲库管理等接口。

 *

 * API 前缀：/api/cloud

 */



const express = require('express');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const CloudDriveManager = require('./manager');

const CloudDriveScanner = require('./scanner');

const CloudDriveStreamer = require('./streamer');



const router = express.Router();

let manager = null;



/**

 * 初始化模块

 * @param {object} db - better-sqlite3 数据库实例

 */

let scanner = null;

let streamer = null;



function init(db) {

  manager = new CloudDriveManager(db);

  scanner = new CloudDriveScanner(manager);

  streamer = new CloudDriveStreamer(manager);



  // 挂载到模块导出，供 netktv-test / netktv-scan 等外部模块访问

  module.exports.manager = manager;

  module.exports.scanner = scanner;

  module.exports.streamer = streamer;

  

  return router;

}



// ==================== Alist 115 扫码登录（参考 alist 官方文档） ====================



const ALIST_URL = process.env.ALIST_INTERNAL_URL || process.env.ALIST_URL || 'http://localhost:5234';

const ALIST_USER = process.env.ALIST_USER || 'admin';

const ALIST_PASS = process.env.ALIST_PASS || 'Dd112233';

const QRCODE_UA = 'Mozilla/5.0 115Browser/23.9.3.2';



/**

 * 带超时的 fetch（115 云盾 WAF 偶发对请求静默丢包，必须主动超时避免连接挂死）

 */

async function fetch115(url, options = {}, timeoutMs = 6000) {

  const controller = new AbortController();

  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {

    return await fetch(url, { ...options, signal: controller.signal });

  } finally {

    clearTimeout(timer);

  }

}



async function alistLogin() {

  const loginData = JSON.stringify({ username: ALIST_USER, password: ALIST_PASS });

  const resp = await fetch(`${ALIST_URL}/api/auth/login`, {

    method: 'POST',

    headers: { 'Content-Type': 'application/json' },

    body: loginData,

  });

  const result = await resp.json();

  if (result.code === 200 && result.data?.token) {

    return result.data.token;

  }

  throw new Error('Alist 登录失败: ' + (result.message || '未知错误'));

}



async function updateAlistStorage(cookie, qrcodeToken) {

  console.log('[Alist] 开始更新存储配置, cookie长度:', cookie ? cookie.length : 0, ', qrcodeToken:', qrcodeToken ? '有' : '无');

  const token = await alistLogin();

  console.log('[Alist] 登录成功, token长度:', token.length);

  

  // 分页查找"115 Cloud"存储（存储数量可能较多，不能只看第一页）。
  // 严格只认 driver === '115 Cloud'：内置 alist 同时存在数百个 "115 Share" 分享存储，
  // 它们的挂载路径里都含"115"，若用 mount_path 模糊匹配会误中（历史 bug：曾误更新到
  // /动漫/合集（115）这类 115 Share 存储并报 no mount path，导致 cookie 没写进真正的 115 Cloud）。
  const TARGET_MOUNT = process.env.ALIST_115_MOUNT || '/🥝115网盘/115';
  const normMount = p => (p || '').replace(/\/+$/, '');
  let cloudFallback = null;
  let storage = null;
  for (let page = 1; page <= 30 && !storage; page++) {
    const getResp = await fetch(`${ALIST_URL}/api/admin/storage/list?page=${page}&per_page=100`, {
      headers: { 'Authorization': token },
    });
    const getResult = await getResp.json();
    if (getResult.code !== 200) {
      throw new Error('获取 Alist 存储列表失败: ' + getResult.message);
    }
    const arr = getResult.data?.content || [];
    if (!arr.length) break;
    for (const item of arr) {
      if (item.driver !== '115 Cloud') continue; // 关键：排除所有 115 Share
      if (normMount(item.mount_path) === normMount(TARGET_MOUNT)) {
        storage = item;
        break;
      }
      if (!cloudFallback) cloudFallback = item;
    }
  }
  if (!storage) storage = cloudFallback;
  if (!storage) {
    throw new Error('未找到 115 Cloud 存储，请先在 Alist 中添加 115 Cloud 驱动（注意不是 115 Share）');
  }
  console.log('[Alist] 找到存储 ID=', storage.id, ', 驱动=', storage.driver, ', 挂载=', storage.mount_path, ', 当前cookie长度:', (storage.addition || '').length);

  

  let addition = {};

  try {

    addition = JSON.parse(storage.addition || '{}');

  } catch (e) {

    addition = {};

  }

  

  // Priority: qrcode_token > cookie

  if (qrcodeToken) {

    addition.qrcode_token = qrcodeToken;

    addition.cookie = ''; // Clear cookie when using qrcode_token

    addition.qrcode_source = addition.qrcode_source || 'wechatmini';

    console.log('[Alist] 使用 qrcode_token 模式');

  } else if (cookie) {

    addition.cookie = cookie;

    addition.qrcode_token = ''; // Clear qrcode_token when using cookie

    console.log('[Alist] 使用 cookie 模式, 新cookie前50字符:', cookie.substring(0, 50) + '...');

  }

  

  const updateData = {

    id: storage.id,

    mount_path: storage.mount_path,

    driver: storage.driver,

    addition: JSON.stringify(addition),

    webdav_policy: storage.webdav_policy || '302_redirect',

    web_proxy: storage.web_proxy || false,

    order: storage.order || 0,

    status: 'work',

  };

  

  console.log('[Alist] 开始更新存储, addition长度:', updateData.addition.length);

  const updateResp = await fetch(`${ALIST_URL}/api/admin/storage/update`, {

    method: 'POST',

    headers: { 'Content-Type': 'application/json', 'Authorization': token },

    body: JSON.stringify(updateData),

  });

  const updateResult = await updateResp.json();

  console.log('[Alist] 更新结果:', JSON.stringify(updateResult));

  if (updateResult.code !== 200) {

    throw new Error('更新 Alist 存储配置失败: ' + updateResult.message);

  }

  

  // Wait for storage to reload and verify

  console.log('[Alist] 等待存储重新加载...');

  await new Promise(r => setTimeout(r, 3000));

  

  // Verify update

  try {

    const verifyResp = await fetch(`${ALIST_URL}/api/admin/storage/get?id=${storage.id}`, {

      headers: { 'Authorization': token },

    });

    const verifyResult = await verifyResp.json();

    if (verifyResult.code === 200) {

      const verifyAddition = JSON.parse(verifyResult.data.addition || '{}');

      console.log('[Alist] 验证更新: 新cookie长度=', verifyAddition.cookie ? verifyAddition.cookie.length : 0, ', status=', verifyResult.data.status);

      if (cookie && verifyAddition.cookie === cookie) {

        console.log('[Alist] ✅ Cookie 更新成功并验证通过');

      } else if (cookie) {

        console.log('[Alist] ⚠️ Cookie 可能未更新, 期望长度=', cookie.length, ', 实际长度=', verifyAddition.cookie ? verifyAddition.cookie.length : 0);

      }

    }

  } catch (verifyErr) {

    console.log('[Alist] 验证更新失败:', verifyErr.message);

  }

  

  return true;

}



/**

 * GET /api/cloud/qrcode/token

 * 获取 115 扫码登录二维码 token（前端主页/管理后台调用）

 * 返回: { uid, time, sign, qrcode_url, qrcode_img }

 */

router.get('/qrcode/token', requireManager, async (req, res) => {

  try {

    const tokenResp = await fetch115('https://qrcodeapi.115.com/api/1.0/web/1.0/token/', {

      headers: { 'User-Agent': QRCODE_UA },

    }, 8000);

    const tokenResult = await tokenResp.json();

    if (!tokenResult.data || !tokenResult.data.uid) {

      return res.status(500).json({ error: '获取二维码 token 失败', detail: tokenResult });

    }

    const { uid, time, sign } = tokenResult.data;

    res.json({

      uid,

      time,

      sign,

      qrcode_url: `https://115.com/scan/dg-${uid}`,

      qrcode_img: `https://qrcodeapi.115.com/api/1.0/mac/1.0/qrcode?uid=${uid}`,

    });

  } catch (err) {

    console.error('[Alist] 获取二维码失败:', err.message);

    res.status(500).json({ error: '获取二维码失败', detail: err.message });

  }

});



/**

 * GET /api/cloud/qrcode/status?uid&time&sign

 * 仅轮询扫码状态，返回数字状态码：0=等待, 1=已扫描待确认, 2=已确认, -1=过期, -2=取消

 * cookie 的获取与 alist 写入统一放到 POST /qrcode/login，避免轮询重复触发

 */

router.get('/qrcode/status', requireManager, async (req, res) => {

  try {

    const { uid, time, sign } = req.query;

    if (!uid || !time || !sign) {

      return res.status(400).json({ error: 'uid, time, sign are required' });

    }

    let statusResult;

    try {

      const statusResp = await fetch115(`https://qrcodeapi.115.com/get/status/?uid=${uid}&time=${time}&sign=${sign}`, {

        headers: { 'User-Agent': QRCODE_UA },

      }, 6000);

      statusResult = await statusResp.json();

    } catch (netErr) {

      // WAF 抖动/超时：返回“继续等待”，让前端下一轮继续轮询，而不是报错卡死

      console.warn('[Alist] 查询扫码状态网络抖动，按等待处理:', netErr.message);

      return res.json({ status: 0, message: '等待扫码', retrying: true });

    }

    const status = statusResult.data?.status ?? 0;

    const statusMsg = { 0: '等待扫码', 1: '已扫码，请在手机上确认', 2: '登录成功', '-1': '二维码已过期', '-2': '已取消' };

    res.json({ status, message: statusMsg[status] || '未知状态' });

  } catch (err) {

    console.error('[Alist] 轮询登录状态失败:', err.message);

    // 兜底也返回等待状态，保证前端轮询不中断

    res.json({ status: 0, message: '等待扫码', retrying: true });

  }

});



/**

 * POST /api/cloud/qrcode/login

 * 扫码确认(status=2)后由前端调用：获取 cookie -> 写入内置 alist -> 创建本地网盘账号

 * Body: { uid, app: 'wechatmini'|'web'|..., name }

 */

router.post('/qrcode/login', requireManager, async (req, res) => {

  try {

    const { uid, app = 'wechatmini', name = '我的115' } = req.body;

    if (!uid) return res.status(400).json({ error: 'uid is required' });



    const loginResp = await fetch115(`https://passportapi.115.com/app/1.0/${app}/1.0/login/qrcode/`, {

      method: 'POST',

      headers: { 'User-Agent': QRCODE_UA, 'Content-Type': 'application/x-www-form-urlencoded' },

      body: `app=${app}&account=${uid}`,

    }, 10000);

    const loginResult = await loginResp.json();

    if (!(loginResult.state === 1 || loginResult.state === true) || !loginResult.data) {

      return res.status(500).json({ error: '获取 cookie 失败', detail: loginResult });

    }

    const c = loginResult.data.cookie || {};

    const parts = [];

    if (c.UID || c.uid) parts.push(`UID=${c.UID || c.uid}`);

    if (c.CID || c.cid) parts.push(`CID=${c.CID || c.cid}`);

    if (c.SEID || c.seid) parts.push(`SEID=${c.SEID || c.seid}`);

    if (c.KID || c.kid) parts.push(`KID=${c.KID || c.kid}`);

    const cookieStr = parts.join('; ');

    if (!cookieStr) return res.status(500).json({ error: '未获取到 cookie', detail: loginResult });



    // 1) 写入内置 alist（实际播放走它的 /d/ 302 直连）

    let alistSync = { synced: false, message: '' };

    try {

      await updateAlistStorage(cookieStr, null);

      alistSync = { synced: true, message: '已同步到内置 alist' };

    } catch (e) {

      alistSync = { synced: false, message: e.message };

      console.error('[Alist] 扫码登录写入 alist 失败:', e.message);

    }



    // 2) 创建本地网盘账号（cloud_accounts，用于曲库扫描）

    const account = manager.createAccountWithCookie('pan115', name, cookieStr);



    res.json({

      success: true,

      account: { id: account.id, driver: account.driver, name: account.name, status: account.status },

      cookie_keys: Object.keys(c),

      alistSync,

    });

  } catch (err) {

    console.error('[Alist] 扫码登录创建账号失败:', err.message);

    res.status(500).json({ error: err.message });

  }

});







function requireManager(req, res, next) {

  if (!manager) {

    return res.status(500).json({ error: 'CloudDrive module not initialized' });

  }

  req.manager = manager;

  req.scanner = scanner;

  req.streamer = streamer;

  next();

}



// ==================== 驱动信息 ====================



/**

 * GET /api/cloud/drivers

 * 列出支持的网盘驱动

 */

router.get('/drivers', requireManager, (req, res) => {

  res.json({ drivers: manager.getSupportedDrivers() });

});



// ==================== 网盘账号管理 ====================



/**

 * GET /api/cloud/accounts

 * 列出所有网盘账号

 */

router.get('/accounts', requireManager, (req, res) => {

  const accounts = manager.listAccounts().map((a) => ({

    ...a,

    access_token: undefined, // 不返回 token

    refresh_token: undefined,

    user_info: a.user_info ? JSON.parse(a.user_info) : null,

  }));

  res.json({ accounts });

});



/**

 * POST /api/cloud/accounts

 * 开始扫码登录（返回二维码）

 * Body: { driver, name? }

 */

router.post('/accounts', requireManager, async (req, res) => {

  try {

    const { driver, name } = req.body;

    if (!driver) {

      return res.status(400).json({ error: 'driver is required' });

    }

    const result = await manager.startQRLogin(driver, name);

    res.json(result);

  } catch (e) {

    console.error('开始扫码登录失败:', e);

    res.status(500).json({ error: e.message });

  }

});



/**

 * POST /api/cloud/accounts/cookie

 * 使用 Cookie 创建账号

 * Body: { driver, name, cookie }

 */

router.post('/accounts/cookie', requireManager, async (req, res) => {

  try {

    const { driver, name, cookie } = req.body;

    if (!driver || !cookie) {

      return res.status(400).json({ error: 'driver and cookie are required' });

    }

    const account = manager.createAccountWithCookie(driver, name || '我的网盘', cookie);

    // 115 账号额外把 cookie 写入内置 alist（实际播放使用）

    let alistSync = null;

    if (driver === 'pan115') {

      alistSync = { synced: false, message: '' };

      try {

        await updateAlistStorage(cookie, null);

        alistSync = { synced: true, message: '已同步到内置 alist' };

      } catch (e) {

        alistSync = { synced: false, message: e.message };

        console.error('[Alist] Cookie 登录写入 alist 失败:', e.message);

      }

    }

    res.json({ ok: true, success: true, account: {

      id: account.id,

      driver: account.driver,

      name: account.name,

      status: account.status,

    }, alistSync });

  } catch (e) {

    console.error('Cookie 登录失败:', e);

    res.status(500).json({ error: e.message });

  }

});



/**

 * GET /api/cloud/accounts/:id/qrcode?qrId=xxx (已禁用)

 * 查询扫码状态

 */

router.get('/accounts/:id/qrcode', requireManager, async (req, res) => {

  try {

    const { qrId } = req.query;

    if (!qrId) {

      return res.status(400).json({ error: 'qrId is required' });

    }

    const result = await manager.checkQRLogin(qrId);

    res.json(result);

  } catch (e) {

    console.error('查询扫码状态失败:', e);

    res.status(500).json({ error: e.message });

  }

});



/**

 * DELETE /api/cloud/accounts/:id

 * 删除网盘账号

 */

router.delete('/accounts/:id', requireManager, (req, res) => {

  try {

    const id = parseInt(req.params.id, 10);

    manager.deleteAccount(id);

    res.json({ ok: true });

  } catch (e) {

    console.error('删除网盘账号失败:', e);

    res.status(500).json({ error: e.message });

  }

});



/**

 * POST /api/cloud/accounts/:id/test

 * 测试网盘账号连接是否正常

 */

router.post('/accounts/:id/test', requireManager, async (req, res) => {

  try {

    const id = parseInt(req.params.id, 10);

    const account = manager.getAccount(id);

    if (!account) {

      return res.status(404).json({ error: '账号不存在' });

    }

    const driver = manager.getDriver(account);

    const result = await driver.testConnection();

    if (result.success) {

      manager.updateAccount(id, { status: 'active' });

      res.json({ success: true });

    } else {

      manager.updateAccount(id, { status: 'error' });

      res.json({ success: false, error: result.error || '连接失败' });

    }

  } catch (e) {

    console.error('测试连接失败:', e);

    res.status(500).json({ success: false, error: e.message });

  }

});



/**

 * POST /api/cloud/accounts/:id/refresh

 * 手动刷新 token

 */

router.post('/accounts/:id/refresh', requireManager, async (req, res) => {

  try {

    const id = parseInt(req.params.id, 10);

    const account = manager.getAccount(id);

    if (!account) {

      return res.status(404).json({ error: '账号不存在' });

    }

    const driver = manager.getDriver(account);

    const tokens = await driver.refreshToken();

    manager.updateAccount(id, {

      access_token: tokens.accessToken,

      refresh_token: tokens.refreshToken,

      token_expires_at: tokens.expiresAt.toISOString(),

    });

    res.json({ ok: true, expiresAt: tokens.expiresAt });

  } catch (e) {

    console.error('刷新token失败:', e);

    res.status(500).json({ error: e.message });

  }

});





// ==================== 网盘文件浏览 ====================



/**

 * GET /api/cloud/accounts/:id/browse?path=/KTV/华语

 * 浏览网盘目录

 */

router.get('/accounts/:id/browse', requireManager, async (req, res) => {

  try {

    const id = parseInt(req.params.id, 10);

    const remotePath = req.query.path || '/';

    const driver = manager.getDriverById(id);

    const files = await driver.listFiles(remotePath);

    res.json({ path: remotePath, files });

  } catch (e) {

    console.error('浏览网盘目录失败:', e);

    res.status(500).json({ error: e.message });

  }

});



/**

 * GET /api/cloud/accounts/:id/userinfo

 * 获取用户信息

 */

router.get('/accounts/:id/userinfo', requireManager, async (req, res) => {

  try {

    const id = parseInt(req.params.id, 10);

    const driver = manager.getDriverById(id);

    const userInfo = await driver.getUserInfo();

    res.json(userInfo);

  } catch (e) {

    console.error('获取用户信息失败:', e);

    res.status(500).json({ error: e.message });

  }

});



// ==================== 网盘曲库管理 ====================



/**

 * GET /api/cloud/libraries

 * 列出所有网盘曲库

 */

router.get('/libraries', requireManager, (req, res) => {

  const libraries = manager.listLibraries();

  res.json({ libraries });

});



/**

 * POST /api/cloud/libraries

 * 添加网盘曲库

 * Body: { account_id, mount_path, local_name }

 */

router.post('/libraries', requireManager, (req, res) => {

  try {

    const { account_id, mount_path, local_name } = req.body;

    if (!account_id || !mount_path || !local_name) {

      return res.status(400).json({ error: 'account_id, mount_path, local_name are required' });

    }

    const id = manager.addLibrary(account_id, mount_path, local_name);

    res.json({ ok: true, id });

  } catch (e) {

    console.error('添加网盘曲库失败:', e);

    res.status(500).json({ error: e.message });

  }

});



/**

 * DELETE /api/cloud/libraries/:id

 * 删除网盘曲库

 */

router.delete('/libraries/:id', requireManager, (req, res) => {

  try {

    const id = parseInt(req.params.id, 10);

    manager.deleteLibrary(id);

    res.json({ ok: true });

  } catch (e) {

    console.error('删除网盘曲库失败:', e);

    res.status(500).json({ error: e.message });

  }

});



/**

 * POST /api/cloud/libraries/:id/scan

 * 触发扫描（异步，扫描状态通过 GET /libraries 查询）

 */

router.post('/libraries/:id/scan', requireManager, async (req, res) => {

  try {

    const id = parseInt(req.params.id, 10);

    // 异步执行扫描

    req.scanner.scanLibrary(id).then((result) => {

      console.log('网盘扫描完成:', result);

    }).catch((e) => console.error('扫描失败:', e));

    res.json({ ok: true, message: '扫描已开始' });

  } catch (e) {

    console.error('触发扫描失败:', e);

    res.status(500).json({ error: e.message });

  }

});



/**

 * GET /api/cloud/stream/:file_id

 * 网盘串流代理（支持 Range 请求）

 */

router.get('/stream/:file_id', requireManager, (req, res) => {

  req.streamer.handleStream(req, res);

});



/**

 * GET /api/cloud/stream-path/:accountId/*

 * 通过文件路径获取网盘直链（302 重定向）

 * 用于 STRM 文件直接包含文件路径，不需要先扫描入库

 * 示例: /api/cloud/stream-path/1/momo-ktv/separated/abc123/vocals.flac

 */

router.get('/stream-path/:accountId/*', requireManager, (req, res) => {

  req.streamer.handleStreamByPath(req, res);

});









// ==================== 原生 115 CDN 直链端点（单层 302，不经过内置 AList） ====================
//
// 背景：原来网页/Tv 端播放 netktv-mkv 歌曲走的是 /api/direct-stream -> 内置 AList /d/
// -> 115 CDN，双重 302。下面这组端点直接用 pan115 驱动换取 115 CDN 真实直链，单层 302，
// 减少一跳。/115-url 不做 302、直接返回 JSON，供前端 MSE 播放器调试 / CORS 检测用。

/**
 * 从 115 CDN 直链探测是否支持浏览器 CORS。
 * 发一个带 Origin + Range: bytes=0-100 的 GET 请求，只读响应头、不拉 body，
 * 检查响应里是否带 access-control-allow-origin。
 * @param {string} cdnUrl - 115 CDN 直链
 * @param {string} origin - 模拟的浏览器 Origin
 * @returns {Promise<{statusCode:number|null, accessControlAllowOrigin:string|null, corsSupported:boolean, responseHeaders:object, error?:string}>}
 */
function probe115Cors(cdnUrl, origin) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(cdnUrl);
    } catch (e) {
      return resolve({ statusCode: null, accessControlAllowOrigin: null, corsSupported: false, responseHeaders: {}, error: 'URL 解析失败: ' + e.message });
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'GET',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        'Origin': origin,
        'Range': 'bytes=0-100',
        'User-Agent': 'Mozilla/5.0',
      },
      timeout: 15000,
    }, (resp) => {
      const acao = resp.headers['access-control-allow-origin'] || null;
      // 只关心响应头，立刻销毁连接，不拉 body
      resp.destroy();
      resolve({
        statusCode: resp.statusCode,
        accessControlAllowOrigin: acao,
        corsSupported: !!acao,
        responseHeaders: resp.headers,
      });
    });
    req.on('error', (e) => resolve({ statusCode: null, accessControlAllowOrigin: null, corsSupported: false, responseHeaders: {}, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ statusCode: null, accessControlAllowOrigin: null, corsSupported: false, responseHeaders: {}, error: '请求超时' }); });
    req.end();
  });
}

/**
 * GET /api/cloud/115-direct/:accountId/*
 * 用指定账号的 pan115 驱动换取 115 CDN 直链，直接 302（单层跳转）。
 * 示例: /api/cloud/115-direct/1/ktv-output/xxx.mkv
 */
router.get('/115-direct/:accountId/*', requireManager, async (req, res) => {
  try {
    const accountId = parseInt(req.params.accountId, 10);
    let filePath = req.params[0] || '';
    try { filePath = decodeURIComponent(filePath); } catch (e) { /* 已是解码后 */ }
    const driver = manager.getDriverById(accountId);
    const { url } = await driver.getDownloadUrlByPath(filePath);
    console.log('[115Direct] account=' + accountId + ' path=' + filePath + ' -> 单层302到CDN');
    res.redirect(302, url);
  } catch (e) {
    console.error('[115Direct] 取直链失败:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/cloud/115-url/:accountId/*
 * 返回 JSON { url, expiresAt }（不做 302），供前端调试 / MSE CORS 检测。
 */
router.get('/115-url/:accountId/*', requireManager, async (req, res) => {
  try {
    const accountId = parseInt(req.params.accountId, 10);
    let filePath = req.params[0] || '';
    try { filePath = decodeURIComponent(filePath); } catch (e) { /* 已是解码后 */ }
    const driver = manager.getDriverById(accountId);
    const { url, expiresAt } = await driver.getDownloadUrlByPath(filePath);
    res.json({ url, expiresAt });
  } catch (e) {
    console.error('[115Url] 取直链失败:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/cloud/115-cors-check/:accountId/*
 * 临时调试端点：换取直链后立即发带 Origin+Range 的探测请求，
 * 判断 115 CDN 是否对网页端 MSE 开放 CORS。结果同时打日志。
 * Query: ?origin=http://localhost:8080 （可改）
 */
router.get('/115-cors-check/:accountId/*', requireManager, async (req, res) => {
  try {
    const accountId = parseInt(req.params.accountId, 10);
    let filePath = req.params[0] || '';
    try { filePath = decodeURIComponent(filePath); } catch (e) { /* 已是解码后 */ }
    const origin = req.query.origin || 'http://localhost:8080';
    const driver = manager.getDriverById(accountId);
    const { url, expiresAt } = await driver.getDownloadUrlByPath(filePath);
    const result = await probe115Cors(url, origin);
    // 关键日志：供服务端运维判断网页端能否直接 fetch 115 CDN
    console.log('[CORS-CHECK] 115 CDN CORS: ' + (result.corsSupported ? 'supported' : 'not-supported')
      + ', origin=' + origin
      + ', status=' + result.statusCode
      + ', ACAO=' + JSON.stringify(result.accessControlAllowOrigin)
      + ', headers=' + JSON.stringify(result.responseHeaders));
    res.json({
      supported: result.corsSupported,
      origin,
      url,
      expiresAt,
      statusCode: result.statusCode,
      accessControlAllowOrigin: result.accessControlAllowOrigin,
      responseHeaders: result.responseHeaders,
      error: result.error,
    });
  } catch (e) {
    console.error('[CORS-CHECK] 失败:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = { init, router };