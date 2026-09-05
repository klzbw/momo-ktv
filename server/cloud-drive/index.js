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
  

// ==================== Alist 115 扫码登录 ====================

const ALIST_URL = process.env.ALIST_URL || 'http://localhost:5235';
const ALIST_USER = process.env.ALIST_USER || 'admin';
const ALIST_PASS = process.env.ALIST_PASS || 'Dd112233';

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

async function updateAlistStorage(cookie) {
  const token = await alistLogin();
  // Get current storage config
  const getResp = await fetch(`${ALIST_URL}/api/admin/storage/list?page=1&per_page=10`, {
    headers: { 'Authorization': token },
  });
  const getResult = await getResp.json();
  if (getResult.code !== 200) {
    throw new Error('获取 Alist 存储列表失败: ' + getResult.message);
  }
  const storage = getResult.data.content.find(s => s.driver === '115 Cloud' || s.mount_path === '/115');
  if (!storage) {
    throw new Error('未找到 115 网盘存储');
  }
  
  // Update addition with new cookie
  let addition = {};
  try {
    addition = JSON.parse(storage.addition || '{}');
  } catch (e) {
    addition = {};
  }
  addition.cookie = cookie;
  
  const updateData = {
    id: storage.id,
    mount_path: storage.mount_path,
    driver: storage.driver,
    addition: JSON.stringify(addition),
    webdav_policy: storage.webdav_policy || '302_redirect',
    web_proxy: storage.web_proxy || false,
    order: storage.order || 0,
    status: storage.status || 'work',
  };
  
  const updateResp = await fetch(`${ALIST_URL}/api/admin/storage/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': token },
    body: JSON.stringify(updateData),
  });
  const updateResult = await updateResp.json();
  if (updateResult.code !== 200) {
    throw new Error('更新 Alist 存储配置失败: ' + updateResult.message);
  }
  return true;
}

/**
 * GET /api/cloud/alist/qrcode
 * 获取 115 扫码登录二维码
 */
router.get('/alist/qrcode', requireManager, async (req, res) => {
  try {
    // Get qrcode token first
    const tokenResp = await fetch('https://qrcodeapi.115.com/api/1.0/web/1.0/token/', {
      headers: { 'User-Agent': 'Mozilla/5.0 115Browser/23.9.3.2' },
    });
    const tokenResult = await tokenResp.json();
    if (!tokenResult.data || !tokenResult.data.uid) {
      return res.status(500).json({ error: '获取二维码 token 失败', detail: tokenResult });
    }
    const uid = tokenResult.data.uid;
    const time = tokenResult.data.time;
    const sign = tokenResult.data.sign;
    
    // Return qrcode info (frontend will display qrcode image)
    res.json({
      uid,
      time,
      sign,
      qrcode_url: `https://qrcodeapi.115.com/api/1.0/mac/1.0/qrcode?uid=${uid}`,
      message: '请使用 115 手机 App 扫描二维码登录',
    });
  } catch (err) {
    console.error('[Alist] 获取二维码失败:', err.message);
    res.status(500).json({ error: '获取二维码失败', detail: err.message });
  }
});

/**
 * GET /api/cloud/alist/qrcode/status?uid=xxx&time=xxx&sign=xxx
 * 轮询 115 扫码登录状态
 */
router.get('/alist/qrcode/status', requireManager, async (req, res) => {
  try {
    const { uid, time, sign } = req.query;
    if (!uid) {
      return res.status(400).json({ error: '缺少 uid 参数' });
    }
    
    const statusResp = await fetch(`https://qrcodeapi.115.com/get/status/?uid=${uid}&time=${time}&sign=${sign}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 115Browser/23.9.3.2' },
    });
    const statusResult = await statusResp.json();
    
    // Status: 0=等待扫码, 1=已扫码未确认, 2=已确认登录成功, -1=二维码过期
    const status = statusResult.data?.status || 0;
    const statusMsg = {
      0: '等待扫码',
      1: '已扫码，请在手机上确认',
      2: '登录成功',
      '-1': '二维码已过期',
    };
    
    if (status === 2 && statusResult.data?.cookie) {
      // Login success, update alist storage
      try {
        await updateAlistStorage(statusResult.data.cookie);
        return res.json({
          status: 2,
          message: '登录成功，已配置到 Alist',
          cookie: statusResult.data.cookie.substring(0, 30) + '...',
        });
      } catch (updateErr) {
        return res.json({
          status: 2,
          message: '登录成功，但配置到 Alist 失败: ' + updateErr.message,
          cookie: statusResult.data.cookie,
        });
      }
    }
    
    res.json({
      status,
      message: statusMsg[status] || '未知状态',
      raw: statusResult.data,
    });
  } catch (err) {
    console.error('[Alist] 轮询登录状态失败:', err.message);
    res.status(500).json({ error: '轮询登录状态失败', detail: err.message });
  }
});


module.exports.scanner = scanner;
  

// ==================== Alist 115 扫码登录 ====================


async function alistLogin() {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: loginData,
  });
  if (result.code === 200 && result.data?.token) {
    return result.data.token;
  }
  throw new Error('Alist 登录失败: ' + (result.message || '未知错误'));
}

async function updateAlistStorage(cookie) {
  // Get current storage config
    headers: { 'Authorization': token },
  });
  if (getResult.code !== 200) {
    throw new Error('获取 Alist 存储列表失败: ' + getResult.message);
  }
  if (!storage) {
    throw new Error('未找到 115 网盘存储');
  }
  
  // Update addition with new cookie
  let addition = {};
  try {
    addition = JSON.parse(storage.addition || '{}');
  } catch (e) {
    addition = {};
  }
  addition.cookie = cookie;
  
    id: storage.id,
    mount_path: storage.mount_path,
    driver: storage.driver,
    addition: JSON.stringify(addition),
    webdav_policy: storage.webdav_policy || '302_redirect',
    web_proxy: storage.web_proxy || false,
    order: storage.order || 0,
    status: storage.status || 'work',
  };
  
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': token },
    body: JSON.stringify(updateData),
  });
  if (updateResult.code !== 200) {
    throw new Error('更新 Alist 存储配置失败: ' + updateResult.message);
  }
  return true;
}

/**
 * GET /api/cloud/alist/qrcode
 * 获取 115 扫码登录二维码
 */
router.get('/alist/qrcode', requireManager, async (req, res) => {
  try {
    // Get qrcode token first
      headers: { 'User-Agent': 'Mozilla/5.0 115Browser/23.9.3.2' },
    });
    if (!tokenResult.data || !tokenResult.data.uid) {
      return res.status(500).json({ error: '获取二维码 token 失败', detail: tokenResult });
    }
    
    // Return qrcode info (frontend will display qrcode image)
    res.json({
      uid,
      time,
      sign,
      qrcode_url: `https://qrcodeapi.115.com/api/1.0/mac/1.0/qrcode?uid=${uid}`,
      message: '请使用 115 手机 App 扫描二维码登录',
    });
  } catch (err) {
    console.error('[Alist] 获取二维码失败:', err.message);
    res.status(500).json({ error: '获取二维码失败', detail: err.message });
  }
});

/**
 * GET /api/cloud/alist/qrcode/status?uid=xxx&time=xxx&sign=xxx
 * 轮询 115 扫码登录状态
 */
router.get('/alist/qrcode/status', requireManager, async (req, res) => {
  try {
    if (!uid) {
      return res.status(400).json({ error: '缺少 uid 参数' });
    }
    
      headers: { 'User-Agent': 'Mozilla/5.0 115Browser/23.9.3.2' },
    });
    
    // Status: 0=等待扫码, 1=已扫码未确认, 2=已确认登录成功, -1=二维码过期
      0: '等待扫码',
      1: '已扫码，请在手机上确认',
      2: '登录成功',
      '-1': '二维码已过期',
    };
    
    if (status === 2 && statusResult.data?.cookie) {
      // Login success, update alist storage
      try {
        await updateAlistStorage(statusResult.data.cookie);
        return res.json({
          status: 2,
          message: '登录成功，已配置到 Alist',
          cookie: statusResult.data.cookie.substring(0, 30) + '...',
        });
      } catch (updateErr) {
        return res.json({
          status: 2,
          message: '登录成功，但配置到 Alist 失败: ' + updateErr.message,
          cookie: statusResult.data.cookie,
        });
      }
    }
    
    res.json({
      status,
      message: statusMsg[status] || '未知状态',
      raw: statusResult.data,
    });
  } catch (err) {
    console.error('[Alist] 轮询登录状态失败:', err.message);
    res.status(500).json({ error: '轮询登录状态失败', detail: err.message });
  }
});


module.exports.streamer = streamer;

  // 注册全局函数，供 hlsgen.js 等模块获取网盘直链（避免循环依赖）
  global.__cloudGetDownloadUrl = async (cloudFileId) => {
    return streamer.getDownloadUrl(cloudFileId);
  };

  // 定时清理过期扫码会话（每5分钟）
  setInterval(() => manager.cleanupExpiredSessions(), 5 * 60 * 1000);

  // 定时刷新 token（每小时）
  setInterval(() => manager.refreshAllTokens().catch(console.error), 60 * 60 * 1000);

  return router;
}

// 中间件：确保 manager 已初始化
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
    if (!account) {
      return res.status(404).json({ error: '账号不存在' });
    }
    const driver = manager.getDriver(account);
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
    if (!account) {
      return res.status(404).json({ error: '账号不存在' });
    }
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
    const remotePath = req.query.path || '/';
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



// ==================== Alist 115 扫码登录 ====================


async function alistLogin() {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: loginData,
  });
  if (result.code === 200 && result.data?.token) {
    return result.data.token;
  }
  throw new Error('Alist 登录失败: ' + (result.message || '未知错误'));
}

async function updateAlistStorage(cookie) {
  // Get current storage config
    headers: { 'Authorization': token },
  });
  if (getResult.code !== 200) {
    throw new Error('获取 Alist 存储列表失败: ' + getResult.message);
  }
  if (!storage) {
    throw new Error('未找到 115 网盘存储');
  }
  
  // Update addition with new cookie
  let addition = {};
  try {
    addition = JSON.parse(storage.addition || '{}');
  } catch (e) {
    addition = {};
  }
  addition.cookie = cookie;
  
    id: storage.id,
    mount_path: storage.mount_path,
    driver: storage.driver,
    addition: JSON.stringify(addition),
    webdav_policy: storage.webdav_policy || '302_redirect',
    web_proxy: storage.web_proxy || false,
    order: storage.order || 0,
    status: storage.status || 'work',
  };
  
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': token },
    body: JSON.stringify(updateData),
  });
  if (updateResult.code !== 200) {
    throw new Error('更新 Alist 存储配置失败: ' + updateResult.message);
  }
  return true;
}

/**
 * GET /api/cloud/alist/qrcode
 * 获取 115 扫码登录二维码
 */
router.get('/alist/qrcode', requireManager, async (req, res) => {
  try {
    // Get qrcode token first
      headers: { 'User-Agent': 'Mozilla/5.0 115Browser/23.9.3.2' },
    });
    if (!tokenResult.data || !tokenResult.data.uid) {
      return res.status(500).json({ error: '获取二维码 token 失败', detail: tokenResult });
    }
    
    // Return qrcode info (frontend will display qrcode image)
    res.json({
      uid,
      time,
      sign,
      qrcode_url: `https://qrcodeapi.115.com/api/1.0/mac/1.0/qrcode?uid=${uid}`,
      message: '请使用 115 手机 App 扫描二维码登录',
    });
  } catch (err) {
    console.error('[Alist] 获取二维码失败:', err.message);
    res.status(500).json({ error: '获取二维码失败', detail: err.message });
  }
});

/**
 * GET /api/cloud/alist/qrcode/status?uid=xxx&time=xxx&sign=xxx
 * 轮询 115 扫码登录状态
 */
router.get('/alist/qrcode/status', requireManager, async (req, res) => {
  try {
    if (!uid) {
      return res.status(400).json({ error: '缺少 uid 参数' });
    }
    
      headers: { 'User-Agent': 'Mozilla/5.0 115Browser/23.9.3.2' },
    });
    
    // Status: 0=等待扫码, 1=已扫码未确认, 2=已确认登录成功, -1=二维码过期
      0: '等待扫码',
      1: '已扫码，请在手机上确认',
      2: '登录成功',
      '-1': '二维码已过期',
    };
    
    if (status === 2 && statusResult.data?.cookie) {
      // Login success, update alist storage
      try {
        await updateAlistStorage(statusResult.data.cookie);
        return res.json({
          status: 2,
          message: '登录成功，已配置到 Alist',
          cookie: statusResult.data.cookie.substring(0, 30) + '...',
        });
      } catch (updateErr) {
        return res.json({
          status: 2,
          message: '登录成功，但配置到 Alist 失败: ' + updateErr.message,
          cookie: statusResult.data.cookie,
        });
      }
    }
    
    res.json({
      status,
      message: statusMsg[status] || '未知状态',
      raw: statusResult.data,
    });
  } catch (err) {
    console.error('[Alist] 轮询登录状态失败:', err.message);
    res.status(500).json({ error: '轮询登录状态失败', detail: err.message });
  }
});


module.exports = { init, router };
