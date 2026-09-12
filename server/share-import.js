/**
 * 115 网盘分享链接导入模块
 *
 * 功能：
 * 1. 管理 115 分享链接（增删改查）
 * 2. 扫描分享链接中的 MKV 文件，加入曲库
 * 3. 预生成 STRM 文件
 * 4. 直链预取
 *
 * 风控优势：使用分享者的账号，自己的 115 账号零 API 调用
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();

let _db = null;
let _Pan115Driver = null;
let _driverCache = null;
let _dataDir = '/data';

// 扫描状态
let _scanState = {
  running: false,
  current: '',
  total: 0,
  done: 0,
  message: '',
};

/**
 * 初始化模块
 */
function init(db, dataDir) {
  _db = db;
  _dataDir = dataDir || '/data';
  _Pan115Driver = require('./cloud-drive/drivers/pan115');

  // 初始化数据库表
  _initDB();

  // 确保 STRM 目录存在
  const strmDir = path.join(_dataDir, 'share-strm');
  if (!fs.existsSync(strmDir)) {
    fs.mkdirSync(strmDir, { recursive: true });
  }

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
}

/**
 * 获取或创建 pan115 driver 单例
 */
function getDriver() {
  if (_driverCache) return _driverCache;
  const account = _db.prepare("SELECT * FROM cloud_accounts WHERE driver='pan115' AND status='active' ORDER BY id DESC LIMIT 1").get();
  if (!account) return null;
  _driverCache = new _Pan115Driver(account);
  return _driverCache;
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

    const driver = getDriver();
    if (!driver) {
      return res.status(400).json({ success: false, error: '未配置 115 账号，请先在云盘管理中添加' });
    }

    // 解析分享快照
    let snap = null;
    try {
      snap = await driver.getShareSnap(pickcode);
    } catch (e) {
      return res.status(400).json({ success: false, error: '分享链接解析失败: ' + e.message });
    }

    const finalShareId = share_id || snap.shareId;
    const finalName = name || snap.title || pickcode;

    // 插入或更新
    const stmt = _db.prepare(`
      INSERT OR REPLACE INTO share_links (platform, name, pickcode, share_id, receive_code, status, file_count, total_size)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
    `);
    const result = stmt.run(platform, finalName, pickcode, finalShareId, receive_code || '', snap.fileCount, snap.size);

    res.json({
      success: true,
      data: {
        id: result.lastInsertRowid,
        name: finalName,
        pickcode,
        share_id: finalShareId,
        file_count: snap.fileCount,
        total_size: snap.size,
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * 删除分享链接
 */
router.delete('/links/:id', (req, res) => {
  const { id } = req.params;
  _db.prepare("DELETE FROM share_links WHERE id = ?").run(id);
  // 同时删除关联的歌曲（可选，这里只标记）
  _db.prepare("UPDATE songs SET share_link_id = NULL WHERE share_link_id = ?").run(id);
  res.json({ success: true });
});

/**
 * 扫描分享链接中的 MKV 文件
 */
router.post('/links/:id/scan', async (req, res) => {
  if (_scanState.running) {
    return res.status(400).json({ success: false, error: '已有扫描任务在运行', state: _scanState });
  }

  const link = _db.prepare("SELECT * FROM share_links WHERE id = ?").get(req.params.id);
  if (!link) {
    return res.status(404).json({ success: false, error: '分享链接不存在' });
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
    const driver = getDriver();
    if (!driver) {
      return res.status(400).json({ success: false, error: '未配置 115 账号' });
    }

    const results = [];
    for (const songId of songIds) {
      const song = _db.prepare("SELECT * FROM songs WHERE id = ?").get(songId);
      if (!song || !song.filepath) continue;

      try {
        // filepath 格式: share:<shareLinkId>:<pickcode> 或 普通路径
        if (song.filepath.startsWith('share:')) {
          const parts = song.filepath.split(':');
          const pickCode = parts[2];
          if (pickCode) {
            await driver.getDownloadUrl(pickCode, 'Mozilla/5.0 (Apple TV; CPU OS 17_0 like Mac OS X)');
            results.push({ id: songId, status: 'ok' });
          }
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
 * 扫描分享链接，将 MKV 文件加入曲库
 */
async function _scanShareLink(link) {
  const driver = getDriver();
  if (!driver) throw new Error('未配置 115 账号');

  _scanState = {
    running: true,
    current: link.name,
    total: 0,
    done: 0,
    message: '正在获取分享文件列表...',
  };

  // 递归获取所有视频文件
  const videos = await driver.listAllShareVideos(link.share_id, link.pickcode);

  _scanState.total = videos.length;
  _scanState.message = `找到 ${videos.length} 个视频文件，正在入库...`;

  let added = 0;
  let skipped = 0;
  const strmDir = path.join(_dataDir, 'share-strm');

  for (const video of videos) {
    _scanState.current = video.name;
    _scanState.done++;

    try {
      // 生成唯一 filename（用 pickcode 避免重名）
      const filename = `${video.pickCode}_${video.name}`;
      const filepath = `share:${link.id}:${video.pickCode}`;

      // 检查是否已存在
      const existing = _db.prepare("SELECT id FROM songs WHERE filename = ?").get(filename);
      if (existing) {
        skipped++;
        continue;
      }

      // 解析歌名和歌手（从文件名）
      const { title, artist } = _parseFilename(video.name);

      // 生成 STRM 文件
      const strmPath = path.join(strmDir, `${video.pickCode}.strm`);
      const strmContent = `http://127.0.0.1:8080/api/share/stream/${link.id}/${video.pickCode}`;
      fs.writeFileSync(strmPath, strmContent, 'utf-8');

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

  // 更新分享链接的扫描时间
  _db.prepare("UPDATE share_links SET last_scan_at = datetime('now'), file_count = ? WHERE id = ?").run(videos.length, link.id);

  _scanState.running = false;
  _scanState.message = `扫描完成：新增 ${added} 首，跳过 ${skipped} 首`;
  console.log(`[ShareImport] 扫描完成: ${link.name}, 新增 ${added}, 跳过 ${skipped}`);
}

/**
 * 从文件名解析歌名和歌手
 * 支持格式：歌手 - 歌名.mkv / 歌名_歌手.mkv / 歌名.mkv
 */
function _parseFilename(filename) {
  // 去掉扩展名
  const name = filename.replace(/\.(mkv|mp4|avi|ts|flv|wmv|mov|m4v)$/i, '');

  // 尝试 "歌手 - 歌名" 格式
  const dashMatch = name.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  if (dashMatch) {
    return { artist: dashMatch[1].trim(), title: dashMatch[2].trim() };
  }

  // 尝试 "歌名_歌手" 格式
  const underscoreMatch = name.match(/^(.+?)_\s*(.+)$/);
  if (underscoreMatch) {
    return { title: underscoreMatch[1].trim(), artist: underscoreMatch[2].trim() };
  }

  // 默认：整个文件名作为歌名
  return { title: name, artist: '未知' };
}

// ==================== 分享流播放端点 ====================

/**
 * 分享文件直链播放（302 重定向到 115 CDN）
 * GET /api/share/stream/:linkId/:pickCode
 */
router.get('/stream/:linkId/:pickCode', async (req, res) => {
  try {
    const { linkId, pickCode } = req.params;
    const driver = getDriver();
    if (!driver) {
      return res.status(500).json({ error: '未配置 115 账号' });
    }

    const userAgent = req.get('User-Agent') || 'Mozilla/5.0 115Browser/23.9.3.2';
    const result = await driver.getDownloadUrl(pickCode, userAgent);

    console.log(`[ShareStream] 302 → 115 CDN (分享来源): ${result.url.substring(0, 80)}...`);
    res.redirect(302, result.url);
  } catch (e) {
    console.error('[ShareStream] 获取直链失败:', e);
    res.status(500).json({ error: '获取直链失败: ' + e.message });
  }
});

module.exports = { init, getScanState: () => _scanState };
