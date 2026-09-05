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


module.exports = { init, router };
