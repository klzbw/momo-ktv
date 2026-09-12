/**
 * 115 网盘分享链接导入模块（通过 Alist 115 Share 驱动实现）
 *
 * 功能：
 * 1. 管理 115 分享链接（增删改查）→ 对应 Alist 中的 115 Share 存储
 * 2. 扫描分享链接中的视频文件，加入曲库
 * 3. 预生成 STRM 文件
 * 4. 直链预取
 *
 * 风控优势：使用分享者的账号，自己的 115 账号零 API 调用
 * 实现方式：通过内置 Alist 的 115 Share 驱动访问分享链接，Alist /d/ 端点 302 到 115 CDN
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const router = express.Router();

let _db = null;
let _dataDir = '/data';
let _alistUrl = 'http://localhost:5234';
let _alistToken = null;
let _alistTokenExpiry = 0;

// 扫描状态
let _scanState = {
  running: false,
  current: '',
  total: 0,
  done: 0,
  message: '',
};

// 视频文件扩展名
const VIDEO_EXTENSIONS = ['.mkv', '.mp4', '.avi', '.ts', '.flv', '.wmv', '.mov', '.m4v', '.rmvb', '.rm'];

/**
 * 初始化模块
 */
function init(db, dataDir) {
  _db = db;
  _dataDir = dataDir || '/data';
  _alistUrl = process.env.ALIST_URL || 'http://localhost:5234';

  // 初始化数据库表
  _initDB();

  // 确保 STRM 目录存在
  const strmDir = path.join(_dataDir, 'share-strm');
  if (!fs.existsSync(strmDir)) {
    fs.mkdirSync(strmDir, { recursive: true });
  }

  // 启动时登录 Alist
  _alistLogin().catch(e => console.warn('[ShareImport] Alist 登录失败:', e.message));

  return router;
}

/**
 * 初始化数据库表
 */
function _initDB() {
  _db.exec(`
    CREATE TABLE IF NOT EXISTS share_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL DEFAULT '115',
      name TEXT NOT NULL,
      pickcode TEXT NOT NULL,
      share_id TEXT,
      receive_code TEXT,
      alist_mount_path TEXT,
      status TEXT DEFAULT 'active',
      file_count INTEGER DEFAULT 0,
      total_size INTEGER DEFAULT 0,
      last_scan_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(platform, pickcode)
    );
  `);

  // 确保 songs 表有 share_link_id 字段
  try {
    _db.exec(`ALTER TABLE songs ADD COLUMN share_link_id INTEGER`);
  } catch (e) {
    // 字段已存在
  }

  // 确保 share_links 表有 alist_mount_path 字段（兼容旧数据库）
  try {
    _db.exec(`ALTER TABLE share_links ADD COLUMN alist_mount_path TEXT`);
  } catch (e) {
    // 字段已存在
  }
}

// ==================== Alist API 封装 ====================

/**
 * 登录 Alist 获取 token
 */
async function _alistLogin(maxRetries = 5) {
  const password = process.env.ALIST_ADMIN_PASSWORD || 'admin123';
  const body = JSON.stringify({ username: 'admin', password });

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await new Promise((resolve, reject) => {
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
                resolve({ success: true, token: r.data.token });
              } else {
                resolve({ success: false, message: r.message || data });
              }
            } catch (e) {
              reject(e);
            }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Alist 登录超时')); });
        req.write(body);
        req.end();
      });

      if (result.success) {
        _alistToken = result.token;
        _alistTokenExpiry = Date.now() + 47 * 3600 * 1000;
        console.log('[ShareImport] Alist 登录成功');
        return _alistToken;
      }

      // Alist 还在加载存储，等待重试
      if (result.message && result.message.includes('Loading storage')) {
        console.log(`[ShareImport] Alist 正在加载存储，等待 5 秒后重试 (${attempt + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      // 其他错误，直接抛出
      throw new Error('Alist 登录失败: ' + result.message);
    } catch (e) {
      if (attempt < maxRetries - 1 && (e.message.includes('timeout') || e.message.includes('ECONNREFUSED'))) {
        console.log(`[ShareImport] Alist 登录异常，等待 3 秒后重试: ${e.message}`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      throw e;
    }
  }
  throw new Error('Alist 登录失败：超过最大重试次数');
}

/**
 * 获取有效的 Alist token（自动刷新）
 */
async function _getAlistToken() {
  if (_alistToken && Date.now() < _alistTokenExpiry) {
    return _alistToken;
  }
  return await _alistLogin();
}

/**
 * 调用 Alist API
 */
async function _alistApi(method, apiPath, body = null, retry = true) {
  const token = await _getAlistToken();
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
          reject(new Error('Alist API 响应解析失败: ' + data.substring(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Alist API 超时: ' + apiPath)); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });

  // token 失效，重新登录后重试
  if (retry && (result.status === 401 || (result.data.code === 401))) {
    console.log('[ShareImport] Alist token 失效，重新登录');
    _alistToken = null;
    return await _alistApi(method, apiPath, body, false);
  }

  return result.data;
}

/**
 * 获取 115 cookie（从 cloud_accounts 表）
 */
function _get115Cookie() {
  const account = _db.prepare("SELECT access_token FROM cloud_accounts WHERE driver='pan115' AND status='active' ORDER BY id DESC LIMIT 1").get();
  return account ? account.access_token : '';
}

/**
 * 在 Alist 中添加 115 Share 存储
 */
async function _alistAddShareStorage(link) {
  const mountPath = `/share-${link.id}`;
  const cookie = _get115Cookie();

  const addition = JSON.stringify({
    cookie: cookie,
    share_code: link.pickcode,
    receive_code: link.receive_code || '',
    page_size: 100,
    root_folder_id: '0',
  });

  const result = await _alistApi('POST', '/api/admin/storage/create', {
    mount_path: mountPath,
    order: link.id,
    driver: '115 Share',
    cache_expiration: 30,
    status: 'work',
    addition: addition,
  });

  if (result.code !== 200 && !result.message.includes('UNIQUE')) {
    throw new Error('Alist 添加存储失败: ' + (result.message || JSON.stringify(result)));
  }

  return mountPath;
}

/**
 * 在 Alist 中删除存储
 */
async function _alistDeleteStorage(storageId) {
  return await _alistApi('POST', '/api/admin/storage/delete', { id: storageId });
}

/**
 * 浏览 Alist 目录
 */
async function _alistListDir(dirPath, page = 1, perPage = 100) {
  const result = await _alistApi('POST', '/api/fs/list', {
    path: dirPath,
    password: '',
    page: page,
    per_page: perPage,
    refresh: false,
  });

  if (result.code !== 200) {
    throw new Error('Alist 浏览失败: ' + (result.message || JSON.stringify(result)));
  }

  return {
    content: result.data.content || [],
    total: result.data.total || 0,
  };
}

/**
 * 递归获取所有视频文件
 */
async function _alistListAllVideos(dirPath, linkId) {
  const videos = [];
  const stack = [dirPath];

  while (stack.length > 0) {
    const currentPath = stack.pop();
    _scanState.current = currentPath;

    try {
      let page = 1;
      let allItems = [];
      while (true) {
        const result = await _alistListDir(currentPath, page, 100);
        allItems = allItems.concat(result.content);
        if (allItems.length >= result.total || result.content.length < 100) break;
        page++;
      }

      for (const item of allItems) {
        const itemPath = currentPath === '/' ? '/' + item.name : currentPath + '/' + item.name;
        if (item.is_dir) {
          stack.push(itemPath);
        } else {
          const ext = path.extname(item.name).toLowerCase();
          if (VIDEO_EXTENSIONS.includes(ext)) {
            videos.push({
              name: item.name,
              path: itemPath,
              size: item.size,
              pickCode: '', // Alist 路径方式不需要 pickcode
            });
          }
        }
      }
    } catch (e) {
      console.warn(`[ShareImport] 跳过目录 ${currentPath}: ${e.message}`);
    }
  }

  return videos;
}

// ==================== API 路由 ====================

/**
 * 列出所有分享链接
 */
router.get('/links', (req, res) => {
  const links = _db.prepare("SELECT * FROM share_links ORDER BY created_at DESC").all();
  res.json({ success: true, data: links });
});

/**
 * 添加分享链接
 * Body: { platform, name, pickcode, share_id, receive_code }
 */
router.post('/links', async (req, res) => {
  try {
    const { platform = '115', name, pickcode, share_id, receive_code } = req.body;

    if (!pickcode) {
      return res.status(400).json({ success: false, error: 'pickcode 不能为空' });
    }

    // 先插入数据库获取 ID
    const finalName = name || pickcode;
    const stmt = _db.prepare(`
      INSERT OR IGNORE INTO share_links (platform, name, pickcode, share_id, receive_code, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `);
    const result = stmt.run(platform, finalName, pickcode, share_id || '', receive_code || '');

    let linkId = result.lastInsertRowid;
    if (result.changes === 0) {
      // 已存在，获取现有 ID
      const existing = _db.prepare("SELECT id FROM share_links WHERE platform=? AND pickcode=?").get(platform, pickcode);
      linkId = existing.id;
    }

    const link = _db.prepare("SELECT * FROM share_links WHERE id = ?").get(linkId);

    // 在 Alist 中添加 115 Share 存储
    try {
      const mountPath = await _alistAddShareStorage(link);
      _db.prepare("UPDATE share_links SET alist_mount_path = ? WHERE id = ?").run(mountPath, linkId);
      link.alist_mount_path = mountPath;
    } catch (e) {
      console.warn('[ShareImport] Alist 添加存储失败:', e.message);
      // 不阻塞，存储可能已存在
    }

    res.json({
      success: true,
      data: {
        id: linkId,
        name: finalName,
        pickcode,
        share_id: share_id || '',
        receive_code: receive_code || '',
        alist_mount_path: link.alist_mount_path,
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * 删除分享链接
 */
router.delete('/links/:id', async (req, res) => {
  const { id } = req.params;
  const link = _db.prepare("SELECT * FROM share_links WHERE id = ?").get(id);
  if (!link) {
    return res.status(404).json({ success: false, error: '分享链接不存在' });
  }

  // 删除 Alist 中的存储
  try {
    const storages = await _alistApi('GET', '/api/admin/storage/list');
    if (storages.code === 200) {
      for (const s of storages.data.content || []) {
        if (s.mount_path === link.alist_mount_path || s.mount_path === `/share-${id}`) {
          await _alistDeleteStorage(s.id);
          break;
        }
      }
    }
  } catch (e) {
    console.warn('[ShareImport] 删除 Alist 存储失败:', e.message);
  }

  // 删除数据库记录
  _db.prepare("DELETE FROM share_links WHERE id = ?").run(id);
  _db.prepare("UPDATE songs SET share_link_id = NULL WHERE share_link_id = ?").run(id);

  res.json({ success: true });
});

/**
 * 扫描分享链接中的视频文件
 */
router.post('/links/:id/scan', async (req, res) => {
  if (_scanState.running) {
    return res.status(400).json({ success: false, error: '已有扫描任务在运行', state: _scanState });
  }

  const link = _db.prepare("SELECT * FROM share_links WHERE id = ?").get(req.params.id);
  if (!link) {
    return res.status(404).json({ success: false, error: '分享链接不存在' });
  }

  // 确保 Alist 存储存在
  if (!link.alist_mount_path) {
    try {
      const mountPath = await _alistAddShareStorage(link);
      _db.prepare("UPDATE share_links SET alist_mount_path = ? WHERE id = ?").run(mountPath, link.id);
      link.alist_mount_path = mountPath;
      // 等待存储加载
      await new Promise(r => setTimeout(r, 5000));
    } catch (e) {
      return res.status(400).json({ success: false, error: 'Alist 存储初始化失败: ' + e.message });
    }
  }

  // 异步执行扫描
  _scanShareLink(link).catch(e => {
    console.error('[ShareImport] 扫描失败:', e);
    _scanState.running = false;
    _scanState.message = '失败: ' + e.message;
  });

  res.json({ success: true, message: '扫描已启动', state: _scanState });
});

/**
 * 获取扫描状态
 */
router.get('/scan-state', (req, res) => {
  res.json({ success: true, state: _scanState });
});

/**
 * 预取直链（批量）
 * Body: { songIds: [id1, id2, ...] }
 */
router.post('/prefetch', async (req, res) => {
  try {
    const { songIds = [] } = req.body;
    const results = [];

    for (const songId of songIds) {
      const song = _db.prepare("SELECT * FROM songs WHERE id = ?").get(songId);
      if (!song || !song.filepath) continue;

      try {
        // filepath 格式: alist:/share-{id}/path/to/video.mkv
        if (song.filepath.startsWith('alist:')) {
          const alistPath = song.filepath.substring(6);
          // 访问 Alist /d/ 端点触发直链缓存
          await new Promise((resolve) => {
            const req = http.get(_alistUrl + '/d' + alistPath, (res) => {
              res.resume();
              res.on('end', resolve);
            });
            req.on('error', resolve);
            req.setTimeout(10000, () => { req.destroy(); resolve(); });
          });
          results.push({ id: songId, status: 'ok' });
        }
      } catch (e) {
        results.push({ id: songId, status: 'error', error: e.message });
      }
    }

    res.json({ success: true, data: results });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ==================== 核心扫描逻辑 ====================

/**
 * 扫描分享链接，将视频文件加入曲库
 */
async function _scanShareLink(link) {
  _scanState = {
    running: true,
    current: link.name,
    total: 0,
    done: 0,
    message: '正在扫描分享文件...',
  };

  const mountPath = link.alist_mount_path || `/share-${link.id}`;

  // 递归获取所有视频文件
  const videos = await _alistListAllVideos(mountPath, link.id);

  _scanState.total = videos.length;
  _scanState.message = `找到 ${videos.length} 个视频文件，正在入库...`;

  let added = 0;
  let skipped = 0;
  let totalSize = 0;
  const strmDir = path.join(_dataDir, 'share-strm');

  for (const video of videos) {
    _scanState.current = video.name;
    _scanState.done++;
    totalSize += video.size || 0;

    try {
      // 生成唯一 filename（用 Alist 路径的 hash 避免重名）
      const pathHash = Buffer.from(video.path).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 16);
      const filename = `${pathHash}_${video.name}`;
      const filepath = `alist:${video.path}`;
      const safeHash = pathHash; // 已过滤非字母数字，不含 /

      // 检查是否已存在
      const existing = _db.prepare("SELECT id FROM songs WHERE filepath = ?").get(filepath);
      if (existing) {
        skipped++;
        continue;
      }

      // 解析歌名和歌手（从文件名）
      const { title, artist } = _parseFilename(video.name);

      // 生成 STRM 文件（指向 momo-ktv 的分享流代理端点）
      const strmPath = path.join(strmDir, `${safeHash}.strm`);
      const strmContent = `http://127.0.0.1:8080/api/share/stream${video.path}`;
      try {
        fs.writeFileSync(strmPath, strmContent, 'utf-8');
      } catch (e) {
        console.warn(`[ShareImport] STRM 写入失败 ${video.name}: ${e.message}`);
      }

      // 插入歌曲
      _db.prepare(`
        INSERT INTO songs (title, artist, filename, filepath, source_root, source_type, is_network, is_strm, share_link_id, duration, audio_tracks)
        VALUES (?, ?, ?, ?, 'share-115', 'share', 1, 1, ?, 0, 2)
      `).run(title, artist || '未知', filename, filepath, link.id);

      added++;
    } catch (e) {
      console.warn(`[ShareImport] 跳过 ${video.name}: ${e.message}`);
      skipped++;
    }
  }

  // 更新分享链接的扫描时间和统计
  _db.prepare("UPDATE share_links SET last_scan_at = datetime('now'), file_count = ?, total_size = ? WHERE id = ?").run(videos.length, totalSize, link.id);

  _scanState.running = false;
  _scanState.message = `扫描完成：新增 ${added} 首，跳过 ${skipped} 首`;
  console.log(`[ShareImport] 扫描完成: ${link.name}, 新增 ${added}, 跳过 ${skipped}, 共 ${videos.length} 个视频`);
}

/**
 * 从文件名解析歌名和歌手
 */
function _parseFilename(filename) {
  const name = filename.replace(/\.(mkv|mp4|avi|ts|flv|wmv|mov|m4v|rmvb|rm)$/i, '');

  const dashMatch = name.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  if (dashMatch) {
    return { artist: dashMatch[1].trim(), title: dashMatch[2].trim() };
  }

  const underscoreMatch = name.match(/^(.+?)_\s*(.+)$/);
  if (underscoreMatch) {
    return { title: underscoreMatch[1].trim(), artist: underscoreMatch[2].trim() };
  }

  return { title: name, artist: '未知' };
}

// ==================== 分享流播放端点（代理 Alist /d/） ====================

/**
 * 分享文件直链播放（代理 Alist /d/ 端点，302 重定向到 115 CDN）
 * GET /api/share/stream/*
 */
router.get('/stream/*', async (req, res) => {
  try {
    const alistPath = '/' + (req.params[0] || '');

    // 构建 Alist /d/ URL，透传客户端 UA（115 CDN 签名与 UA 绑定）
    const alistUrl = _alistUrl + '/d' + alistPath;

    // 向 Alist 发起请求，获取 302 重定向地址
    const userAgent = req.get('User-Agent') || 'Mozilla/5.0 115Browser/23.9.3.2';

    const redirectUrl = await new Promise((resolve, reject) => {
      const req = http.get(alistUrl, {
        headers: { 'User-Agent': userAgent },
        timeout: 15000,
      }, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          resolve(res.headers.location);
        } else if (res.statusCode === 200) {
          // Alist 可能直接返回文件流（web_proxy 模式），直接代理
          resolve(null);
        } else {
          reject(new Error('Alist 返回状态码: ' + res.statusCode));
        }
        res.resume();
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Alist 请求超时')); });
    });

    if (redirectUrl) {
      console.log(`[ShareStream] 302 → 115 CDN (Alist代理): ${alistPath.substring(0, 60)}...`);
      res.redirect(302, redirectUrl);
    } else {
      // Alist 直接返回流，透传
      console.log(`[ShareStream] Alist 直连代理: ${alistPath.substring(0, 60)}...`);
      const proxyReq = http.get(alistUrl, { headers: { 'User-Agent': userAgent } }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });
      proxyReq.on('error', (e) => res.status(502).json({ error: e.message }));
    }
  } catch (e) {
    console.error('[ShareStream] 获取直链失败:', e.message);
    res.status(502).json({ error: '获取直链失败: ' + e.message });
  }
});

module.exports = { init, getScanState: () => _scanState };
