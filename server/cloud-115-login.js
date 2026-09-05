/**
 * 115 网盘扫码登录模块
 * 实现与 Gbox 相同的扫码登录功能
 *
 * 流程：
 * 1. 获取二维码 token（uid/sign/time）
 * 2. 获取二维码图片
 * 3. 轮询扫码状态
 * 4. 扫码确认后获取 cookie
 * 5. 更新 alist 115 Cloud 存储配置
 */

const express = require('express');
const router = express.Router();
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 内存中保存扫码会话
const qrSessions = new Map();

/**
 * 发起 HTTPS GET 请求
 */
function httpsGet(url, headers = {}, encoding = 'utf-8') {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': UA,
        'Accept': '*/*',
        'Referer': 'https://115.com/',
        ...headers
      }
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (encoding === 'binary') {
          resolve({ statusCode: res.statusCode, headers: res.headers, body: buf });
        } else {
          resolve({ statusCode: res.statusCode, headers: res.headers, body: buf.toString('utf-8') });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('请求超时')));
    req.end();
  });
}

/**
 * 发起 HTTP GET 请求（用于访问本地 alist）
 */
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 80,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') });
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('请求超时')));
    req.end();
  });
}

/**
 * 发起 HTTP POST 请求（JSON）
 */
function httpPost(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const body = JSON.stringify(data);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 80,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers
      }
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') });
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('请求超时')));
    req.write(body);
    req.end();
  });
}

/**
 * 获取 alist 管理员 token
 */
async function getAlistToken() {
  const res = await httpPost('http://localhost:5234/api/auth/login', {
    username: 'admin',
    password: process.env.ALIST_PASS || 'Dd112233'
  });
  const data = JSON.parse(res.body);
  if (data.code === 200) {
    return data.data.token;
  }
  throw new Error('alist 登录失败: ' + data.message);
}

/**
 * 找到 115 Cloud 存储
 */
async function find115Storage(token) {
  // 分页查找
  for (let page = 1; page <= 20; page++) {
    const res = await httpGet(`http://localhost:5234/api/admin/storage/list?page=${page}&per_page=100`, {
      'Authorization': token
    });
    const data = JSON.parse(res.body);
    if (data.code !== 200) break;
    const content = data.data?.content || [];
    if (content.length === 0) break;

    for (const s of content) {
      if (s.driver === '115 Cloud') {
        return s;
      }
    }
  }
  return null;
}

// ============ API 路由 ============

/**
 * GET /api/115/qrcode/generate
 * 生成 115 登录二维码
 */
router.get('/qrcode/generate', async (req, res) => {
  try {
    console.log('[115Login] 生成扫码登录二维码');

    // Step 1: 获取 token
    const tokenRes = await httpsGet('https://qrcodeapi.115.com/api/1.0/web/1.0/token/');
    const tokenData = JSON.parse(tokenRes.body);

    if (tokenData.state !== 1 || tokenData.code !== 0) {
      return res.status(500).json({ error: '获取二维码 token 失败', detail: tokenData });
    }

    const { uid, sign, time, qrcode } = tokenData.data;

    // Step 2: 获取二维码图片（base64）
    const qrRes = await httpsGet(
      `https://qrcodeapi.115.com/api/1.0/web/1.0/qrcode?uid=${uid}`,
      {}, 'binary'
    );

    if (qrRes.statusCode !== 200) {
      return res.status(500).json({ error: '获取二维码图片失败' });
    }

    const qrBase64 = qrRes.body.toString('base64');

    // 保存会话
    const sessionId = uid;
    qrSessions.set(sessionId, {
      uid, sign, time,
      createdAt: Date.now(),
      status: 'waiting', // waiting / scanned / confirmed / expired
      cookie: null
    });

    console.log('[115Login] 二维码生成成功 uid=', uid);

    res.json({
      success: true,
      sessionId,
      uid,
      sign,
      time,
      qrcodeUrl: qrcode, // 115 官方扫码链接
      qrImage: `data:image/png;base64,${qrBase64}` // 二维码图片 base64
    });
  } catch (error) {
    console.error('[115Login] 生成二维码失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/115/qrcode/status?uid=xxx&sign=xxx&time=xxx
 * 轮询扫码状态
 */
router.get('/qrcode/status', async (req, res) => {
  try {
    const { uid, sign, time } = req.query;
    if (!uid) {
      return res.status(400).json({ error: '缺少 uid 参数' });
    }

    // 调用 115 API 检查状态
    const params = new URLSearchParams({ uid });
    if (sign) params.set('sign', sign);
    if (time) params.set('time', time);
    params.set('_', Date.now().toString());

    const statusRes = await httpsGet(
      `https://qrcodeapi.115.com/get/status/?${params.toString()}`
    );
    const statusData = JSON.parse(statusRes.body);

    // 115 状态码：1=已扫描待确认，2=已确认登录，其他=等待/过期
    let status = 'waiting';
    let cookie = null;

    const innerStatus = statusData.data?.status;
    if (innerStatus === 1) {
      status = 'scanned';
    } else if (innerStatus === 2) {
      status = 'confirmed';

      // 扫码确认后，获取 cookie
      try {
        cookie = await fetch115Cookie(uid, sign, time);
        if (cookie) {
          // 更新会话
          const session = qrSessions.get(uid);
          if (session) {
            session.status = 'confirmed';
            session.cookie = cookie;
          }
        }
      } catch (e) {
        console.error('[115Login] 获取 cookie 失败:', e.message);
      }
    } else if (statusData.code === 40199002 || statusData.code === 40199009) {
      status = 'expired';
    }

    // 更新会话状态
    const session = qrSessions.get(uid);
    if (session && !cookie) {
      session.status = status;
    }

    res.json({
      success: true,
      status,
      rawStatus: innerStatus,
      cookie: cookie,
      message: statusData.message
    });
  } catch (error) {
    console.error('[115Login] 检查扫码状态失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 扫码确认后获取 115 cookie
 */
async function fetch115Cookie(uid, sign, time) {
  try {
    // 115 扫码登录确认接口
    const params = new URLSearchParams({
      uid,
      sign: sign || '',
      time: String(time || ''),
      _: Date.now().toString()
    });

    const loginRes = await httpsGet(
      `https://passportapi.115.com/app/1.0/web/1.0/login/qrcode/?${params.toString()}`,
      { 'Referer': 'https://115.com/' }
    );

    console.log('[115Login] 登录响应:', loginRes.body.substring(0, 300));

    const loginData = JSON.parse(loginRes.body);
    if (loginData.state === 1 || loginData.code === 0) {
      const cookieInfo = loginData.data?.cookie || {};
      // 组装 cookie 字符串
      const parts = [];
      if (cookieInfo.UID) parts.push(`UID=${cookieInfo.UID}`);
      if (cookieInfo.CID) parts.push(`CID=${cookieInfo.CID}`);
      if (cookieInfo.SEID) parts.push(`SEID=${cookieInfo.SEID}`);
      if (cookieInfo.KID) parts.push(`KID=${cookieInfo.KID}`);

      if (parts.length > 0) {
        const cookieStr = parts.join('; ');
        console.log('[115Login] 获取 cookie 成功:', cookieStr.substring(0, 50) + '...');
        return cookieStr;
      }
    }

    // 备选：从 Set-Cookie 头中提取
    const setCookie = loginRes.headers['set-cookie'];
    if (setCookie && setCookie.length > 0) {
      const parts = [];
      for (const c of setCookie) {
        const match = c.match(/^(UID|CID|SEID|KID)=([^;]+)/);
        if (match) parts.push(`${match[1]}=${match[2]}`);
      }
      if (parts.length > 0) return parts.join('; ');
    }

    return null;
  } catch (e) {
    console.error('[115Login] fetch115Cookie 错误:', e.message);
    return null;
  }
}

/**
 * POST /api/115/cookie/update
 * 手动更新 115 cookie 到 alist
 */
router.post('/cookie/update', async (req, res) => {
  try {
    const { cookie } = req.body;
    if (!cookie || !cookie.includes('UID=')) {
      return res.status(400).json({ error: 'Cookie 格式不正确，需要包含 UID=' });
    }

    const result = await updateAlist115Cookie(cookie);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[115Login] 更新 cookie 失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 更新 alist 中 115 Cloud 存储的 cookie
 */
async function updateAlist115Cookie(cookie) {
  // 获取 alist token
  const alistToken = await getAlistToken();

  // 找到 115 Cloud 存储
  const storage = await find115Storage(alistToken);
  if (!storage) {
    throw new Error('未找到 115 Cloud 存储，请先在 alist 中添加');
  }

  // 更新存储配置
  const addition = JSON.parse(storage.addition);
  addition.cookie = cookie;

  const updateData = {
    id: storage.id,
    mount_path: storage.mount_path,
    order: storage.order,
    driver: storage.driver,
    cache_expiration: storage.cache_expiration,
    status: storage.status,
    addition: JSON.stringify(addition),
    remark: storage.remark,
    disabled: storage.disabled,
    enable_sign: storage.enable_sign,
    order_by: storage.order_by,
    order_direction: storage.order_direction,
    extract_folder: storage.extract_folder,
    web_proxy: storage.web_proxy,
    webdav_policy: storage.webdav_policy,
    down_proxy_url: storage.down_proxy_url
  };

  const updateRes = await httpPost(
    'http://localhost:5234/api/admin/storage/update',
    updateData,
    { 'Authorization': alistToken }
  );
  const result = JSON.parse(updateRes.body);

  if (result.code !== 200) {
    throw new Error('alist 更新存储失败: ' + result.message);
  }

  console.log('[115Login] alist 115 Cloud cookie 更新成功, storage id=', storage.id);

  return {
    storageId: storage.id,
    mountPath: storage.mount_path,
    message: 'Cookie 更新成功'
  };
}

/**
 * GET /api/115/status
 * 查询当前 115 登录状态
 */
router.get('/status', async (req, res) => {
  try {
    const alistToken = await getAlistToken();
    const storage = await find115Storage(alistToken);

    if (!storage) {
      return res.json({
        loggedIn: false,
        status: 'not_configured',
        message: '未配置 115 Cloud 存储'
      });
    }

    const addition = JSON.parse(storage.addition);
    const cookie = addition.cookie || '';
    const hasCookie = cookie && cookie.includes('UID=') && cookie !== 'xxx';

    // 提取 UID
    let uid = '';
    const uidMatch = cookie.match(/UID=([^;]+)/);
    if (uidMatch) uid = uidMatch[1];

    res.json({
      loggedIn: hasCookie && storage.status === 'work',
      status: storage.status,
      storageId: storage.id,
      mountPath: storage.mount_path,
      uid: uid,
      cookiePreview: hasCookie ? cookie.substring(0, 30) + '...' : '',
      disabled: storage.disabled === 1 || storage.disabled === true
    });
  } catch (error) {
    console.error('[115Login] 查询状态失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/115/test
 * 测试 115 连接是否正常
 */
router.post('/test', async (req, res) => {
  try {
    const alistToken = await getAlistToken();
    const storage = await find115Storage(alistToken);

    if (!storage) {
      return res.json({ success: false, message: '未找到 115 Cloud 存储' });
    }

    // 列出根目录测试
    const listRes = await httpPost(
      'http://localhost:5234/api/fs/list',
      {
        path: storage.mount_path,
        page: 1,
        per_page: 10,
        refresh: true
      },
      { 'Authorization': alistToken }
    );

    const listData = JSON.parse(listRes.body);
    if (listData.code === 200) {
      const files = listData.data?.content || [];
      res.json({
        success: true,
        message: '连接正常',
        fileCount: files.length,
        files: files.slice(0, 10).map(f => f.name)
      });
    } else {
      res.json({
        success: false,
        message: listData.message || '连接失败'
      });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/115/apply-scan
 * 将扫码获取的 cookie 应用到 alist
 */
router.post('/apply-scan', async (req, res) => {
  try {
    const { uid } = req.body;
    const session = qrSessions.get(uid);

    if (!session) {
      return res.status(400).json({ error: '扫码会话不存在或已过期，请重新生成二维码' });
    }

    if (session.status !== 'confirmed' || !session.cookie) {
      return res.status(400).json({ error: '尚未完成扫码确认', status: session.status });
    }

    const result = await updateAlist115Cookie(session.cookie);
    qrSessions.delete(uid);

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[115Login] 应用扫码结果失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 定期清理过期会话（5分钟）
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of qrSessions.entries()) {
    if (now - session.createdAt > 5 * 60 * 1000) {
      qrSessions.delete(id);
    }
  }
}, 60 * 1000);

module.exports = router;
