/**
 * 全网盘共享链接导入模块（通过 AList 各网盘 Share 驱动实现）
 *
 * 支持的网盘类型（参考 gbox-alist-tvbox）：
 * 1. ali      - 阿里云盘分享 (AliyunShare)
 * 2. pikpak   - PikPak分享 (PikPakShare)
 * 3. thunder  - 迅雷分享 (ThunderShare)
 * 4. 123      - 123网盘分享 (123PanShare)
 * 5. quark    - 夸克分享 (QuarkShare)
 * 6. 139      - 移动云盘分享 (Yun139Share)
 * 7. uc       - UC网盘分享 (UCShare)
 * 8. 115      - 115网盘分享 (115 Share)
 * 9. 189      - 天翼云盘分享 (189Share)
 * 10. baidu   - 百度网盘分享 (BaiduShare2)
 * 11. guangya - 光芽网盘分享 (GuangYaPanShare)
 *
 * 功能：
 * 1. 管理各网盘分享链接（增删改查）→ 对应 AList 中的各 Share 存储
 * 2. 自动识别分享链接类型（从URL解析）
 * 3. 扫描分享链接中的媒体文件，加入曲库
 * 4. 预生成 STRM 文件（指向 AList /d/ 路径）
 * 5. 分享流播放代理（代理 AList /d/ 端点，302 到各网盘 CDN）
 *
 * 风控优势：使用分享者的账号，自己的网盘账号零 API 调用
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
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

// 媒体文件扩展名（视频+音频）
const MEDIA_EXTENSIONS = [
  '.mkv', '.mp4', '.avi', '.ts', '.flv', '.wmv', '.mov', '.m4v', '.rmvb', '.rm',
  '.flac', '.ape', '.wav', '.mp3', '.aac', '.ogg', '.m4a', '.wma',
];

// ==================== 网盘驱动配置 ====================

/**
 * 全部网盘共享链接类型配置
 * 参考 gbox-alist-tvbox 的 ShareService.saveStorage() 和各 Share 存储类
 */
const DRIVE_CONFIGS = {
  ali: {
    id: 0,
    name: '阿里云盘',
    driver: 'AliyunShare',
    webdavPolicy: '302_redirect',
    mountPrefix: '/我的阿里分享/',
    addition: (share) => ({
      share_id: share.share_id,
      share_pwd: share.password || '',
      root_folder_id: share.folder_id || 'root',
      order_by: 'name',
      order_direction: 'ASC',
    }),
    urlPatterns: [
      /https:\/\/www\.(?:alipan|aliyundrive)\.com\/s\/([\w-]+)\/folder\/([\w-]+)(?:\?password=(\w+))?/,
      /https:\/\/www\.(?:alipan|aliyundrive)\.com\/s\/([\w-]+)(?:\?password=(\w+))?/,
    ],
  },
  pikpak: {
    id: 1,
    name: 'PikPak',
    driver: 'PikPakShare',
    webdavPolicy: '302_redirect',
    mountPrefix: '/我的PikPak分享/',
    addition: (share) => ({
      share_id: share.share_id,
      share_pwd: share.password || '',
      root_folder_id: share.folder_id || '',
      platform: 'pc',
    }),
    urlPatterns: [
      /https:\/\/mypikpak\.com\/s\/([\w-]+)(?:\?pwd=(\w+))?/,
    ],
  },
  thunder: {
    id: 2,
    name: '迅雷',
    driver: 'ThunderShare',
    webdavPolicy: '302_redirect',
    mountPrefix: '/我的迅雷分享/',
    addition: (share) => ({
      share_id: share.share_id,
      share_pwd: share.password || '',
      root_folder_id: share.folder_id || '',
    }),
    urlPatterns: [
      /https:\/\/pan\.xunlei\.com\/s\/([\w-]+)(?:\?pwd=(\w+))?/,
    ],
  },
  '123': {
    id: 3,
    name: '123网盘',
    driver: '123PanShare',
    webdavPolicy: '302_redirect',
    mountPrefix: '/我的123分享/',
    addition: (share) => ({
      share_id: share.share_id,
      share_pwd: share.password || '',
      root_folder_id: share.folder_id || '0',
    }),
    urlPatterns: [
      /https:\/\/(?:www\.)?123(?:684|685|865|912|pan|592)\.(?:com|cn)\/s\/([\w-]+)提取码[:：](\w+)/,
      /https:\/\/(?:www\.)?123(?:684|685|865|912|pan|592)\.(?:com|cn)\/s\/([\w-]+)(?:\.html)?(?:\?提取码=(\w+))?/,
      /https:\/\/.+\.share\.123pan\.cn\/123pan\/([\w-]+)/,
      /https:\/\/(?:www\.)?123pan\.(?:cn|com)\/123pan\/([\w-]+)/,
    ],
  },
  quark: {
    id: 5,
    name: '夸克',
    driver: 'QuarkShare',
    webdavPolicy: 'native_proxy',
    mountPrefix: '/我的夸克分享/',
    addition: (share) => ({
      share_id: share.share_id,
      share_pwd: share.password || '',
      root_folder_id: share.folder_id || '0',
      order_by: 'file_name',
      order_direction: 'asc',
    }),
    urlPatterns: [
      /https:\/\/pan\.quark\.cn\/s\/([\w-]+)/,
    ],
  },
  '139': {
    id: 6,
    name: '移动云盘',
    driver: 'Yun139Share',
    webdavPolicy: '302_redirect',
    mountPrefix: '/我的移动分享/',
    addition: (share) => ({
      share_id: share.share_id,
      share_pwd: share.password || '',
      root_folder_id: share.folder_id || '',
    }),
    urlPatterns: [
      /https:\/\/caiyun\.139\.com\/m\/i\?([\w-]+)/,
      /https:\/\/yun\.139\.com\/shareweb\/#\/w\/i\/([\w-]+)/,
      /https:\/\/caiyun\.139\.com\/w\/i\/([\w-]+)/,
      /https:\/\/caiyun\.feixin\.10086\.cn\/([\w-]+)/,
    ],
  },
  uc: {
    id: 7,
    name: 'UC网盘',
    driver: 'UCShare',
    webdavPolicy: 'native_proxy',
    mountPrefix: '/我的UC分享/',
    addition: (share) => ({
      share_id: share.share_id,
      share_pwd: share.password || '',
      root_folder_id: share.folder_id || '0',
      order_by: 'file_name',
      order_direction: 'asc',
    }),
    urlPatterns: [
      /https:\/\/(?:drive|fast)\.uc\.cn\/s\/([\w-]+)(?:\?password=(\w+))?/,
    ],
  },
  '115': {
    id: 8,
    name: '115网盘',
    driver: '115 Share',
    webdavPolicy: '302_redirect',
    mountPrefix: '/我的115分享/',
    addition: (share) => ({
      cookie: share.cookie || '',
      share_code: share.share_id,
      receive_code: share.password || '',
      page_size: 100,
      root_folder_id: share.folder_id || '0',
    }),
    urlPatterns: [
      /https:\/\/(?:115|115cdn|anxia)\.com\/s\/([\w-]+)(?:\?password=([\w-]+))?/,
    ],
  },
  '189': {
    id: 9,
    name: '天翼云盘',
    driver: '189Share',
    webdavPolicy: '302_redirect',
    mountPrefix: '/我的天翼分享/',
    addition: (share) => ({
      share_id: share.share_id,
      share_pwd: share.password || '',
      root_folder_id: share.folder_id || '',
    }),
    urlPatterns: [
      /https:\/\/cloud\.189\.cn\/web\/share\?code=([\w-]+)/,
      /https:\/\/cloud\.189\.cn\/t\/([\w-]+)(?:（访问码：(\w+)）)?/,
      /https:\/\/h5\.cloud\.189\.cn\/share\.html#\/t\/([\w-]+)/,
    ],
  },
  baidu: {
    id: 10,
    name: '百度网盘',
    driver: 'BaiduShare2',
    webdavPolicy: '302_redirect',
    mountPrefix: '/我的百度分享/',
    addition: (share) => ({
      surl: share.share_id,
      pwd: share.password || '',
      root_folder_path: share.folder_id || '/',
    }),
    urlPatterns: [
      /https:\/\/pan\.baidu\.com\/s\/([\w-]+)(?:\?pwd=(\w+))?/,
      /https:\/\/pan\.baidu\.com\/(?:share|wap)\/init\?surl=([\w-]+)(?:&pwd=(\w+))?/,
    ],
  },
  guangya: {
    id: 12,
    name: '光芽网盘',
    driver: 'GuangYaPanShare',
    webdavPolicy: '302_redirect',
    mountPrefix: '/我的光芽分享/',
    addition: (share) => {
      const add = {
        share_id: share.share_id,
        share_pwd: share.password || '',
        page_size: 200,
        order_by: 0,
        sort_type: 0,
      };
      if (share.device_id) add.device_id = share.device_id;
      return add;
    },
    urlPatterns: [
      /https:\/\/(?:www\.)?guangyapan\.com\/s\/([A-Za-z0-9_-]+)/,
    ],
  },
};

/**
 * 从分享链接 URL 自动识别网盘类型并解析参数
 * @param {string} url - 分享链接
 * @returns {object|null} { platform, share_id, password, folder_id }
 */
function parseShareUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();

  for (const [platform, config] of Object.entries(DRIVE_CONFIGS)) {
    for (const pattern of config.urlPatterns) {
      const m = trimmed.match(pattern);
      if (m) {
        const result = {
          platform,
          share_id: m[1],
          password: m[2] || '',
          folder_id: m[3] || '',
        };
        // 百度网盘 share_id 规范化（22位补1前缀变23位）
        if (platform === 'baidu' && result.share_id.length === 22 && !result.share_id.startsWith('1')) {
          result.share_id = '1' + result.share_id;
        }
        return result;
      }
    }
  }
  return null;
}

// ==================== 初始化 ====================

function init(db, dataDir) {
  _db = db;
  _dataDir = dataDir || '/data';
  _alistUrl = process.env.ALIST_URL || 'http://localhost:5234';

  _initDB();

  // 确保 STRM 目录存在
  const strmDir = path.join(_dataDir, 'share-strm');
  if (!fs.existsSync(strmDir)) {
    fs.mkdirSync(strmDir, { recursive: true });
  }

  // 启动时登录 Alist（延迟等待 AList 启动）
  setTimeout(() => {
    _alistLogin().catch(e => console.warn('[ShareImport] Alist 登录失败:', e.message));
  }, 5000);

  return router;
}

function _initDB() {
  _db.exec(`
    CREATE TABLE IF NOT EXISTS share_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL DEFAULT '115',
      name TEXT NOT NULL,
      share_id TEXT NOT NULL,
      password TEXT DEFAULT '',
      folder_id TEXT DEFAULT '',
      alist_mount_path TEXT,
      status TEXT DEFAULT 'active',
      file_count INTEGER DEFAULT 0,
      total_size INTEGER DEFAULT 0,
      last_scan_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(platform, share_id)
    );
  `);

  // 兼容旧表结构：添加缺失字段
  const columns = _db.prepare("PRAGMA table_info(share_links)").all();
  const colNames = columns.map(c => c.name);
  if (!colNames.includes('share_id')) {
    _db.exec("ALTER TABLE share_links ADD COLUMN share_id TEXT");
    // 迁移旧 pickcode 数据
    _db.exec("UPDATE share_links SET share_id = pickcode WHERE share_id IS NULL");
  }
  if (!colNames.includes('password')) {
    _db.exec("ALTER TABLE share_links ADD COLUMN password TEXT DEFAULT ''");
    _db.exec("UPDATE share_links SET password = receive_code WHERE password = ''");
  }
  if (!colNames.includes('folder_id')) {
    _db.exec("ALTER TABLE share_links ADD COLUMN folder_id TEXT DEFAULT ''");
  }

  // 确保 songs 表有 share_link_id 字段
  try {
    _db.exec("ALTER TABLE songs ADD COLUMN share_link_id INTEGER");
  } catch (e) { /* 已存在 */ }

  try {
    _db.exec("ALTER TABLE songs ADD COLUMN is_strm INTEGER DEFAULT 0");
  } catch (e) { /* 已存在 */ }
}

// ==================== Alist API 封装 ====================

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
            } catch (e) { reject(e); }
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
      if (result.message && result.message.includes('Loading storage')) {
        console.log(`[ShareImport] Alist 正在加载存储，等待 5 秒后重试 (${attempt + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
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

async function _getAlistToken() {
  if (_alistToken && Date.now() < _alistTokenExpiry) return _alistToken;
  return await _alistLogin();
}

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
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (e) { reject(new Error('Alist API 响应解析失败: ' + data.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Alist API 超时: ' + apiPath)); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });

  if (retry && (result.status === 401 || (result.data.code === 401))) {
    console.log('[ShareImport] Alist token 失效，重新登录');
    _alistToken = null;
    return await _alistApi(method, apiPath, body, false);
  }
  return result.data;
}

/**
 * 在 Alist 中添加共享存储（根据网盘类型使用对应驱动）
 */
async function _alistAddShareStorage(link) {
  const config = DRIVE_CONFIGS[link.platform];
  if (!config) {
    throw new Error('不支持的网盘类型: ' + link.platform);
  }

  const mountPath = config.mountPrefix + link.id;
  const addition = JSON.stringify(config.addition(link));

  const result = await _alistApi('POST', '/api/admin/storage/create', {
    mount_path: mountPath,
    order: link.id,
    driver: config.driver,
    cache_expiration: 30,
    status: 'work',
    addition: addition,
  });

  if (result.code !== 200 && !result.message.includes('UNIQUE')) {
    throw new Error('Alist 添加存储失败: ' + (result.message || JSON.stringify(result)));
  }

  return mountPath;
}

async function _alistDeleteStorage(storageId) {
  return await _alistApi('POST', '/api/admin/storage/delete', { id: storageId });
}

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
  return { content: result.data.content || [], total: result.data.total || 0 };
}

async function _alistListAllMedia(dirPath) {
  const media = [];
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
          if (MEDIA_EXTENSIONS.includes(ext)) {
            media.push({ name: item.name, path: itemPath, size: item.size });
          }
        }
      }
    } catch (e) {
      console.warn(`[ShareImport] 跳过目录 ${currentPath}: ${e.message}`);
    }
  }
  return media;
}

// ==================== API 路由 ====================

/**
 * 获取支持的网盘类型列表
 */
router.get('/drive-types', (req, res) => {
  const types = Object.entries(DRIVE_CONFIGS).map(([key, config]) => ({
    key,
    id: config.id,
    name: config.name,
    driver: config.driver,
  }));
  res.json({ success: true, data: types });
});

/**
 * 解析分享链接（自动识别网盘类型）
 * Body: { url }
 */
router.post('/parse-link', (req, res) => {
  const { url } = req.body;
  const parsed = parseShareUrl(url);
  if (!parsed) {
    return res.status(400).json({ success: false, error: '无法识别的分享链接' });
  }
  const config = DRIVE_CONFIGS[parsed.platform];
  res.json({
    success: true,
    data: {
      ...parsed,
      drive_name: config.name,
      driver: config.driver,
    },
  });
});

/**
 * 列出所有分享链接
 */
router.get('/links', (req, res) => {
  const links = _db.prepare("SELECT * FROM share_links ORDER BY created_at DESC").all();
  res.json({ success: true, data: links });
});

/**
 * 添加分享链接
 * Body: { platform, name, url, share_id, password, folder_id }
 * 支持两种方式：传 url 自动解析，或直接传 platform+share_id
 */
router.post('/links', async (req, res) => {
  try {
    let { platform, name, url, share_id, password, folder_id } = req.body;

    // 如果传了 url，自动解析
    if (url) {
      const parsed = parseShareUrl(url);
      if (parsed) {
        platform = parsed.platform;
        share_id = parsed.share_id;
        password = password || parsed.password;
        folder_id = folder_id || parsed.folder_id;
      }
    }

    if (!platform || !DRIVE_CONFIGS[platform]) {
      return res.status(400).json({ success: false, error: '请指定有效的网盘类型' });
    }
    if (!share_id) {
      return res.status(400).json({ success: false, error: '分享ID不能为空' });
    }

    const config = DRIVE_CONFIGS[platform];
    const finalName = name || `${config.name}-${share_id.substring(0, 8)}`;

    // 先插入数据库获取 ID
    const stmt = _db.prepare(`
      INSERT OR IGNORE INTO share_links (platform, name, share_id, password, folder_id, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `);
    const result = stmt.run(platform, finalName, share_id, password || '', folder_id || '');

    let linkId = result.lastInsertRowid;
    if (result.changes === 0) {
      const existing = _db.prepare("SELECT id FROM share_links WHERE platform=? AND share_id=?").get(platform, share_id);
      linkId = existing.id;
    }

    const link = _db.prepare("SELECT * FROM share_links WHERE id = ?").get(linkId);

    // 在 Alist 中添加对应网盘的 Share 存储
    try {
      const mountPath = await _alistAddShareStorage(link);
      _db.prepare("UPDATE share_links SET alist_mount_path = ? WHERE id = ?").run(mountPath, linkId);
      link.alist_mount_path = mountPath;
    } catch (e) {
      console.warn('[ShareImport] Alist 添加存储失败:', e.message);
    }

    res.json({
      success: true,
      data: {
        id: linkId,
        platform,
        name: finalName,
        share_id,
        password: password || '',
        folder_id: folder_id || '',
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
        if (s.mount_path === link.alist_mount_path) {
          await _alistDeleteStorage(s.id);
          break;
        }
      }
    }
  } catch (e) {
    console.warn('[ShareImport] 删除 Alist 存储失败:', e.message);
  }

  // 查询该分享链接对应的所有歌曲
  const songs = _db.prepare("SELECT filename FROM songs WHERE share_link_id = ?").all(id);

  // 清理 STRM 文件
  const strmDir = path.join(_dataDir, 'share-strm');
  for (const song of songs) {
    const hashMatch = song.filename.match(/^([a-f0-9]+)_/);
    if (hashMatch) {
      const strmPath = path.join(strmDir, hashMatch[1] + '.strm');
      try { if (fs.existsSync(strmPath)) fs.unlinkSync(strmPath); } catch (e) { /* ignore */ }
    }
  }

  _db.prepare("DELETE FROM songs WHERE share_link_id = ?").run(id);
  _db.prepare("DELETE FROM share_links WHERE id = ?").run(id);
  console.log(`[ShareImport] 删除分享链接 #${id}(${link.platform})，清理 ${songs.length} 首歌曲`);

  res.json({ success: true, deletedSongs: songs.length });
});

/**
 * 扫描分享链接中的媒体文件
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
      await new Promise(r => setTimeout(r, 5000));
    } catch (e) {
      return res.status(400).json({ success: false, error: 'Alist 存储初始化失败: ' + e.message });
    }
  }

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

// ==================== 核心扫描逻辑 ====================

async function _scanShareLink(link) {
  _scanState = {
    running: true,
    current: link.name,
    total: 0,
    done: 0,
    message: '正在扫描分享文件...',
  };

  const mountPath = link.alist_mount_path;
  const mediaFiles = await _alistListAllMedia(mountPath);

  _scanState.total = mediaFiles.length;
  _scanState.message = `找到 ${mediaFiles.length} 个媒体文件，正在入库...`;

  let added = 0;
  let skipped = 0;
  let totalSize = 0;
  const strmDir = path.join(_dataDir, 'share-strm');

  for (const file of mediaFiles) {
    _scanState.current = file.name;
    _scanState.done++;
    totalSize += file.size || 0;

    try {
      const pathHash = crypto.createHash('sha256').update(file.path).digest('hex').substring(0, 16);
      const filename = `${pathHash}_${file.name}`;
      const filepath = `alist:${file.path}`;

      const existing = _db.prepare("SELECT id FROM songs WHERE filepath = ?").get(filepath);
      if (existing) { skipped++; continue; }

      const { title, artist } = _parseFilename(file.name);

      // 生成 STRM 文件（指向 momo-ktv 的分享流代理端点）
      const strmPath = path.join(strmDir, `${pathHash}.strm`);
      const strmContent = `http://127.0.0.1:8080/api/share/stream${file.path}`;
      try { fs.writeFileSync(strmPath, strmContent, 'utf-8'); }
      catch (e) { console.warn(`[ShareImport] STRM 写入失败 ${file.name}: ${e.message}`); }

      _db.prepare(`
        INSERT INTO songs (title, artist, filename, filepath, source_root, source_type, is_network, is_strm, share_link_id, duration, audio_tracks)
        VALUES (?, ?, ?, ?, 'strm-shared', 'share', 1, 1, ?, 0, 2)
      `).run(title, artist || '未知', filename, filepath, link.id);

      added++;
    } catch (e) {
      console.warn(`[ShareImport] 跳过 ${file.name}: ${e.message}`);
      skipped++;
    }
  }

  _db.prepare("UPDATE share_links SET last_scan_at = datetime('now'), file_count = ?, total_size = ? WHERE id = ?").run(mediaFiles.length, totalSize, link.id);

  _scanState.running = false;
  _scanState.message = `扫描完成：新增 ${added} 首，跳过 ${skipped} 首`;
  console.log(`[ShareImport] 扫描完成: ${link.name}(${link.platform}), 新增 ${added}, 跳过 ${skipped}, 共 ${mediaFiles.length} 个文件`);
}

function _parseFilename(filename) {
  const name = filename.replace(/\.(mkv|mp4|avi|ts|flv|wmv|mov|m4v|rmvb|rm|flac|ape|wav|mp3|aac|ogg|m4a|wma)$/i, '');
  const dashMatch = name.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  if (dashMatch) return { artist: dashMatch[1].trim(), title: dashMatch[2].trim() };
  const underscoreMatch = name.match(/^(.+?)_\s*(.+)$/);
  if (underscoreMatch) return { title: underscoreMatch[1].trim(), artist: underscoreMatch[2].trim() };
  return { title: name, artist: '未知' };
}

// ==================== 分享流播放端点（代理 Alist /d/） ====================

/**
 * 分享文件直链播放（代理 Alist /d/ 端点，302 重定向到网盘 CDN）
 * GET /api/share/stream/*
 */
router.get('/stream/*', async (req, res) => {
  try {
    const alistPath = '/' + (req.params[0] || '');
    const alistUrl = _alistUrl + '/d' + alistPath;
    const userAgent = req.get('User-Agent') || 'Mozilla/5.0';

    const redirectUrl = await new Promise((resolve, reject) => {
      const req = http.get(alistUrl, {
        headers: { 'User-Agent': userAgent },
        timeout: 15000,
      }, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          resolve(res.headers.location);
        } else if (res.statusCode === 200) {
          resolve(null); // web_proxy 模式直接返回流
        } else {
          reject(new Error('Alist 返回状态码: ' + res.statusCode));
        }
        res.resume();
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Alist 请求超时')); });
    });

    if (redirectUrl) {
      console.log(`[ShareStream] 302 → CDN: ${alistPath.substring(0, 60)}...`);
      res.redirect(302, redirectUrl);
    } else {
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

module.exports = { init, getScanState: () => _scanState, parseShareUrl, DRIVE_CONFIGS };
