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
 * Body: { driver: 'pan115', name?: '我的115' }
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
 * 使用 Cookie 创建账号（适用于 115 等二维码接口失效的网盘）
 * Body: { driver: 'pan115', name: '我的115', cookie: 'UID=xxx; CID=xxx; SEID=xxx' }
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
 * GET /api/cloud/accounts/:id/qrcode?qrId=xxx
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


// ==================== 115 扫码登录（新接口） ====================

const https = require('https');

/**
 * 发送 HTTPS 请求的辅助函数
 */
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
  });
}

function httpsPost(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams(data).toString();
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        ...headers,
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, body });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
    req.write(postData);
    req.end();
  });
}

const QRCODE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 115Browser/23.9.3.2',
};

/**
 * GET /api/cloud/qrcode/token
 * 获取 115 扫码登录二维码 token
 * 返回: { uid, time, sign, qrcode_url, qrcode_img }
 */
router.get('/qrcode/token', requireManager, async (req, res) => {
  try {
    const result = await httpsGet('https://qrcodeapi.115.com/api/1.0/web/1.0/token/', QRCODE_HEADERS);
    if (result.status !== 200 || !result.body.state) {
      return res.status(500).json({ error: '获取二维码失败', detail: result.body });
    }
    const data = result.body.data;
    res.json({
      uid: data.uid,
      time: data.time,
      sign: data.sign,
      qrcode_url: data.qrcode,
      qrcode_img: `https://qrcodeapi.115.com/api/1.0/mac/1.0/qrcode?uid=${data.uid}`,
    });
  } catch (e) {
    console.error('获取二维码 token 失败:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/cloud/qrcode/status?uid=xxx&time=xxx&sign=xxx
 * 查询扫码状态
 * status: 0=等待, 1=已扫描, 2=已登录, -1=过期, -2=取消
 */
router.get('/qrcode/status', requireManager, async (req, res) => {
  try {
    const { uid, time, sign } = req.query;
    if (!uid || !time || !sign) {
      return res.status(400).json({ error: 'uid, time, sign are required' });
    }
    const url = `https://qrcodeapi.115.com/get/status/?uid=${uid}&time=${time}&sign=${sign}`;
    const result = await httpsGet(url, QRCODE_HEADERS);
    if (result.status !== 200) {
      return res.status(500).json({ error: '查询状态失败', detail: result.body });
    }
    const data = result.body.data || {};
    res.json({
      status: data.status,
      message: data.message || '',
    });
  } catch (e) {
    console.error('查询扫码状态失败:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/cloud/qrcode/login
 * 扫码登录成功后，获取 cookie 并创建网盘账号
 * Body: { uid, app: 'wechatmini'|'web'|'android'..., name: '我的115' }
 */
router.post('/qrcode/login', requireManager, async (req, res) => {
  try {
    const { uid, app = 'wechatmini', name = '我的115' } = req.body;
    if (!uid) {
      return res.status(400).json({ error: 'uid is required' });
    }

    // 调用 115 登录接口获取 cookie
    const url = `https://passportapi.115.com/app/1.0/${app}/1.0/login/qrcode/`;
    const result = await httpsPost(url, { app, account: uid }, QRCODE_HEADERS);

    if (result.status !== 200 || !result.body.state) {
      return res.status(500).json({ error: '登录失败', detail: result.body });
    }

    const cookieData = result.body.data.cookie || {};
    // 构造 cookie 字符串
    const cookieStr = Object.entries(cookieData)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

    if (!cookieStr) {
      return res.status(500).json({ error: '未获取到 cookie', detail: result.body });
    }

    // 使用 cookie 创建账号
    const account = manager.createAccountWithCookie('pan115', name, cookieStr);

    res.json({
      success: true,
      account: {
        id: account.id,
        driver: account.driver,
        name: account.name,
        status: account.status,
      },
      cookie_keys: Object.keys(cookieData),
    });
  } catch (e) {
    console.error('扫码登录创建账号失败:', e);
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
