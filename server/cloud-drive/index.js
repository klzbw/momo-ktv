/**
 * 网盘曲库集成模块入口
 * 注册 API 路由，提供网盘账号管理、文件浏览、曲库管理等接口。
 *
 * API 前缀：/api/cloud
 */

const express = require('express');
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

const ALIST_URL = process.env.ALIST_URL || 'http://localhost:5235';
const ALIST_USER = process.env.ALIST_USER || 'admin';
const ALIST_PASS = process.env.ALIST_PASS || 'Dd112233';
const QRCODE_UA = 'Mozilla/5.0 115Browser/23.9.3.2';

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
  
  const getResp = await fetch(`${ALIST_URL}/api/admin/storage/list?page=1&per_page=10`, {
    headers: { 'Authorization': token },
  });
  const getResult = await getResp.json();
  if (getResult.code !== 200) {
    throw new Error('获取 Alist 存储列表失败: ' + getResult.message);
  }
  console.log('[Alist] 存储列表数量:', getResult.data?.content?.length || 0);
  
  const storage = getResult.data.content.find(s => s.driver === '115 Cloud' || s.mount_path === '/115');
  if (!storage) {
    throw new Error('未找到 115 网盘存储，请先在 Alist 中添加 115 Cloud 驱动');
  }
  console.log('[Alist] 找到存储 ID=', storage.id, ', 挂载=', storage.mount_path, ', 当前cookie长度:', (storage.addition || '').length);
  
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
 * GET /api/cloud/alist/qrcode
 * 获取 115 扫码登录二维码（参考 alist 官方文档）
 * Step 1: GET https://qrcodeapi.115.com/api/1.0/web/1.0/token/
 * Step 2: 显示二维码图片 https://qrcodeapi.115.com/api/1.0/mac/1.0/qrcode?uid=<uid>
 */
router.get('/alist/qrcode', requireManager, async (req, res) => {
  try {
    const tokenResp = await fetch('https://qrcodeapi.115.com/api/1.0/web/1.0/token/', {
      headers: { 'User-Agent': QRCODE_UA },
    });
    const tokenResult = await tokenResp.json();
    if (!tokenResult.data || !tokenResult.data.uid) {
      return res.status(500).json({ error: '获取二维码 token 失败', detail: tokenResult });
    }
    const { uid, time, sign } = tokenResult.data;
    
    res.json({
      uid,
      time,
      sign,
      qrcode_url: `https://qrcodeapi.115.com/api/1.0/mac/1.0/qrcode?uid=${uid}`,
      message: '请使用 115 手机 App 扫描二维码，选择不常用设备（如 wechatmini）登录',
    });
  } catch (err) {
    console.error('[Alist] 获取二维码失败:', err.message);
    res.status(500).json({ error: '获取二维码失败', detail: err.message });
  }
});

/**
 * GET /api/cloud/alist/qrcode/status?uid=xxx&time=xxx&sign=xxx&app=wechatmini
 * 轮询 115 扫码登录状态
 * Step 3: GET https://qrcodeapi.115.com/get/status/?uid=<uid>&time=<time>&sign=<sign>
 * Step 4 (status=2): POST https://passportapi.115.com/app/1.0/{app}/1.0/login/qrcode/ 获取 cookie
 */
router.get('/alist/qrcode/status', requireManager, async (req, res) => {
  try {
    const { uid, time, sign, app = 'wechatmini' } = req.query;
    if (!uid) {
      return res.status(400).json({ error: '缺少 uid 参数' });
    }
    
    const statusResp = await fetch(`https://qrcodeapi.115.com/get/status/?uid=${uid}&time=${time}&sign=${sign}`, {
      headers: { 'User-Agent': QRCODE_UA },
    });
    const statusResult = await statusResp.json();
    const status = statusResult.data?.status ?? 0;
    
    const statusMsg = {
      0: '等待扫码',
      1: '已扫码，请在手机上确认',
      2: '登录成功',
      '-1': '二维码已过期',
      '-2': '已取消',
    };
    
    if (status === 2) {
      // Step 4: Call passportapi to get cookie
      try {
        const loginResp = await fetch(`https://passportapi.115.com/app/1.0/${app}/1.0/login/qrcode/`, {
          method: 'POST',
          headers: { 
            'User-Agent': QRCODE_UA,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: `app=${app}&account=${uid}`,
        });
        const loginResult = await loginResp.json();
        console.log('[Alist] passportapi 返回完整数据:', JSON.stringify(loginResult).substring(0, 800));
        console.log('[Alist] passportapi state:', loginResult.state, ', data keys:', loginResult.data ? Object.keys(loginResult.data) : '无data');
        
        // 115 passportapi 返回 state=1 (数字) 表示成功，cookie 字段在 data 中
        if ((loginResult.state === 1 || loginResult.state === true) && loginResult.data) {
          const data = loginResult.data;
          // 提取 cookie 字段：UID(或uid)、CID、SEID、KID
          // cookie 字段在 data.cookie 中
          const cookieObj = data.cookie || {};
          const uid = cookieObj.UID || cookieObj.uid || '';
          const cid = cookieObj.CID || cookieObj.cid || '';
          const seid = cookieObj.SEID || cookieObj.seid || '';
          const kid = cookieObj.KID || cookieObj.kid || '';
          console.log('[Alist] 提取到的字段: uid=' + String(uid||'空').substring(0, 25) + ', cid=' + String(cid||'空').substring(0, 25) + ', seid=' + String(seid||'空').substring(0, 25) + ', kid=' + String(kid||'空').substring(0, 25));
          const cookieParts = [];
          if (uid) cookieParts.push(`UID=${uid}`);
          if (cid) cookieParts.push(`CID=${cid}`);
          if (seid) cookieParts.push(`SEID=${seid}`);
          if (kid) cookieParts.push(`KID=${kid}`);
          const cookieStr = cookieParts.join('; ');
          console.log('[Alist] 构造的 cookie 长度:', cookieStr.length, ', 内容:', cookieStr.substring(0, 100));
          console.log('[Alist] 获取 cookie 成功:', cookieStr.substring(0, 50) + '...');
          
          // Update alist storage with cookie
          try {
            await updateAlistStorage(cookieStr, null);
            return res.json({
              status: 2,
              message: '登录成功，已自动配置到 Alist',
              cookie_preview: cookieStr.substring(0, 50) + '...',
              app,
            });
          } catch (updateErr) {
            return res.json({
              status: 2,
              message: '登录成功，但配置到 Alist 失败: ' + updateErr.message,
              cookie: cookieStr,
              app,
            });
          }
        } else {
          return res.json({
            status: 2,
            message: '扫码确认成功，但获取 cookie 失败: ' + (loginResult.error || JSON.stringify(loginResult)),
            raw: loginResult,
          });
        }
      } catch (loginErr) {
        return res.json({
          status: 2,
          message: '扫码确认成功，但调用登录接口失败: ' + loginErr.message,
        });
      }
    }
    
    res.json({
      status,
      message: statusMsg[status] || '未知状态',
    });
  } catch (err) {
    console.error('[Alist] 轮询登录状态失败:', err.message);
    res.status(500).json({ error: '轮询登录状态失败', detail: err.message });
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
router.post('/accounts/cookie', requireManager, (req, res) => {
  try {
    const { driver, name, cookie } = req.body;
    if (!driver || !cookie) {
      return res.status(400).json({ error: 'driver and cookie are required' });
    }
    const account = manager.createAccountWithCookie(driver, name || '我的网盘', cookie);
    res.json({ ok: true, account: {
      id: account.id,
      driver: account.driver,
      name: account.name,
      status: account.status,
    }});
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




module.exports = { init, router };