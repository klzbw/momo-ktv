/**
 * 网络 KTV 测试模块
 * 直接从 115 挂载路径读取分离文件，提供测试 API 和串流代理
 *
 * 挂载路径：/vol02/1000-1-fb5e5d14/momo-ktv/separated/<sha256前16位>/
 *   - vocals.flac (人声)
 *   - accompaniment.flac (伴奏)
 *
 * API：
 *   GET /api/netktv/songs - 列出已上传的歌曲
 *   GET /api/netktv/stream/:dir/:type - 串流代理（type: vocals/accompaniment）
 *   GET /api/netktv/info/:dir - 获取歌曲信息（时长、文件大小等）
 *
 * 多账号支持：
 *   串流时从 songs 表查询该歌曲的 cloud_account_id，动态选择对应 115 账号获取直链。
 *   若歌曲无 cloud_account_id（旧数据兼容），则遍历所有 active 账号尝试。
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const https = require('https');
const http = require('http');

const router = express.Router();

// 115 挂载路径（分离文件）
const SEPARATED_DIR = '/vol02/1000-1-fb5e5d14/momo-ktv/separated';

// cloud-drive 模块引用（通过 init 注入）
let cloudDrive = null;
let db = null;
let cloudAccountId = null; // 默认回退账号（兼容旧配置）
let cloudBasePath = '/momo-ktv/separated';

/**
 * 初始化模块，注入 cloud-drive 依赖
 */
function init(options = {}) {
  if (options.cloudDrive) cloudDrive = options.cloudDrive;
  if (options.db) db = options.db;
  if (options.accountId) cloudAccountId = options.accountId;
  if (options.basePath) cloudBasePath = options.basePath;
  return router;
}

/**
 * GET /api/netktv/songs
 * 列出已上传的完整歌曲（同时有人声和伴奏）
 */
router.get('/songs', (req, res) => {
  try {
    if (!fs.existsSync(SEPARATED_DIR)) {
      return res.status(404).json({ error: '分离文件目录不存在', path: SEPARATED_DIR });
    }

    const dirs = fs.readdirSync(SEPARATED_DIR);
    const songs = [];

    for (const dir of dirs) {
      const fullPath = path.join(SEPARATED_DIR, dir);
      if (!fs.statSync(fullPath).isDirectory()) continue;

      const files = fs.readdirSync(fullPath);
      const vocalFile = files.find((f) => f.includes('人声') || f.includes('vocals'));
      const accompFile = files.find((f) => f.includes('伴奏') || f.includes('accompaniment'));

      if (vocalFile && accompFile) {
        // 从文件名提取歌手和歌名
        let artist = '未知';
        let title = vocalFile.replace(/(-人声|-vocals)\.flac$/i, '');
        if (title.includes('-')) {
          const parts = title.split('-');
          artist = parts[0].trim();
          title = parts.slice(1).join('-').trim();
        }

        const vocalStat = fs.statSync(path.join(fullPath, vocalFile));
        const accompStat = fs.statSync(path.join(fullPath, accompFile));

        songs.push({
          id: dir,
          artist,
          title,
          vocal_file: vocalFile,
          accompaniment_file: accompFile,
          vocal_size: vocalStat.size,
          accompaniment_size: accompStat.size,
          total_size: vocalStat.size + accompStat.size,
          // 串流地址
          vocal_url: `/api/netktv/stream/${dir}/vocals`,
          accompaniment_url: `/api/netktv/stream/${dir}/accompaniment`,
        });
      }
    }

    res.json({
      total: songs.length,
      songs,
    });
  } catch (e) {
    console.error('获取歌曲列表失败:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/netktv/info/:dir
 * 获取歌曲详细信息（时长、编码等）
 */
router.get('/info/:dir', (req, res) => {
  try {
    const dir = req.params.dir;
    const fullPath = path.join(SEPARATED_DIR, dir);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: '歌曲不存在' });
    }

    const files = fs.readdirSync(fullPath);
    const vocalFile = files.find((f) => f.includes('人声') || f.includes('vocals'));
    const accompFile = files.find((f) => f.includes('伴奏') || f.includes('accompaniment'));

    const info = { id: dir };

    if (vocalFile) {
      try {
        const dur = execFileSync('ffprobe', [
          '-v', 'error', '-show_entries', 'format=duration',
          '-of', 'csv=p=0', path.join(fullPath, vocalFile),
        ], { timeout: 10000 }).toString().trim();
        info.vocal_duration = parseFloat(dur);
      } catch (e) {
        info.vocal_duration = null;
      }
    }

    if (accompFile) {
      try {
        const dur = execFileSync('ffprobe', [
          '-v', 'error', '-show_entries', 'format=duration',
          '-of', 'csv=p=0', path.join(fullPath, accompFile),
        ], { timeout: 10000 }).toString().trim();
        info.accompaniment_duration = parseFloat(dur);
      } catch (e) {
        info.accompaniment_duration = null;
      }
    }

    if (info.vocal_duration && info.accompaniment_duration) {
      info.sync = Math.abs(info.vocal_duration - info.accompaniment_duration) < 0.1;
    }

    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 根据歌曲目录名（songKey）从数据库查询所属的云盘账号 ID
 * 支持多账号：不同账号下的同名歌曲分别关联各自账号
 * @param {string} dir - 歌曲目录名（16位 hex）
 * @returns {number|null} cloud_account_id 或 null
 */
function lookupSongAccountId(dir) {
  if (!db) return null;
  try {
    const row = db.prepare(
      "SELECT cloud_account_id FROM songs WHERE source_root = 'netktv' AND filepath LIKE ? LIMIT 1"
    ).get(`%${dir}_vocals.strm%`);
    if (row && row.cloud_account_id) {
      return row.cloud_account_id;
    }
  } catch (e) {
    console.warn('[NETKTV] 查询歌曲账号ID失败:', e.message);
  }
  return null;
}

/**
 * 获取所有 active 状态的云盘账号列表
 * @returns {Array} 账号列表
 */
function listActiveAccounts() {
  if (!cloudDrive || !cloudDrive.manager) return [];
  try {
    return cloudDrive.manager.listAccounts().filter(a => a.status === 'active');
  } catch (e) {
    console.warn('[NETKTV] 获取active账号列表失败:', e.message);
    return [];
  }
}

/**
 * 通过指定账号获取 115 文件的 302 直链
 * @param {object} driver - 云盘驱动实例
 * @param {string} dir - 歌曲目录名
 * @param {string} type - vocals / accompaniment
 * @param {string} basePath - 基础路径
 * @returns {object|null} { url, fileName } 或 null
 */
async function getDirectUrlWithDriver(driver, dir, type, basePath) {
  const dirPath = `${basePath}/${dir}`;
  const files = await driver.listFiles(dirPath);

  let fileName;
  if (type === 'vocals') {
    fileName = files.find((f) => f.name.includes('人声') || f.name.includes('vocals'))?.name;
  } else {
    fileName = files.find((f) => f.name.includes('伴奏') || f.name.includes('accompaniment'))?.name;
  }

  if (!fileName) return null;

  const filePath = `${dirPath}/${fileName}`;
  const result = await driver.getDownloadUrlByPath(filePath);
  return { url: result.url, fileName };
}

/**
 * 通过 cloud-drive 获取 115 文件的 302 直链
 * 多账号逻辑：
 *   1. 优先从数据库查询该歌曲的 cloud_account_id，用对应账号
 *   2. 若查询不到（旧数据），用 init 时设置的默认账号 cloudAccountId
 *   3. 若默认账号也失败，遍历所有 active 账号逐一尝试
 */
async function getCloudDirectUrl(dir, type) {
  if (!cloudDrive) return null;

  const manager = cloudDrive.manager;
  if (!manager) return null;

  // 步骤1：从数据库查询歌曲所属账号
  const songAccountId = lookupSongAccountId(dir);
  if (songAccountId) {
    try {
      const account = manager.getAccount(songAccountId);
      if (account && account.status === 'active') {
        const driver = manager.getDriver(account);
        const result = await getDirectUrlWithDriver(driver, dir, type, cloudBasePath);
        if (result) {
          console.log(`[NETKTV] 使用数据库记录的账号ID=${songAccountId} 获取直链: ${dir}/${type}`);
          return result;
        }
      }
    } catch (e) {
      console.warn(`[NETKTV] 账号ID=${songAccountId} 获取直链失败: ${e.message}`);
    }
  }

  // 步骤2：用默认回退账号
  if (cloudAccountId) {
    try {
      const driver = manager.getDriverById(cloudAccountId);
      if (driver) {
        const result = await getDirectUrlWithDriver(driver, dir, type, cloudBasePath);
        if (result) {
          console.log(`[NETKTV] 使用默认账号ID=${cloudAccountId} 获取直链: ${dir}/${type}`);
          return result;
        }
      }
    } catch (e) {
      console.warn(`[NETKTV] 默认账号ID=${cloudAccountId} 获取直链失败: ${e.message}`);
    }
  }

  // 步骤3：遍历所有 active 账号尝试（兼容旧数据 / 自动识别）
  const activeAccounts = listActiveAccounts();
  for (const account of activeAccounts) {
    // 跳过已经试过的账号
    if (account.id === songAccountId || account.id === cloudAccountId) continue;
    try {
      const driver = manager.getDriver(account);
      const result = await getDirectUrlWithDriver(driver, dir, type, cloudBasePath);
      if (result) {
        console.log(`[NETKTV] 遍历账号找到匹配: 账号ID=${account.id} (${account.name}) 获取直链: ${dir}/${type}`);
        // 自动回写：将该歌曲关联到此账号，下次直接用
        if (db) {
          try {
            db.prepare(
              "UPDATE songs SET cloud_account_id = ? WHERE source_root = 'netktv' AND filepath LIKE ? AND (cloud_account_id IS NULL OR cloud_account_id = 0)"
            ).run(account.id, `%${dir}_vocals.strm%`);
          } catch (e) { /* 忽略回写失败 */ }
        }
        return result;
      }
    } catch (e) {
      console.warn(`[NETKTV] 账号ID=${account.id} 尝试失败: ${e.message}`);
    }
  }

  return null;
}

/**
 * GET /api/netktv/stream/:dir/:type
 * 串流代理
 * - 优先通过 cloud-drive 获取 115 302 直链（标准方案，不依赖挂载，支持多账号）
 * - 回退到直接从 115 挂载路径读取文件（兼容现有部署）
 * type: vocals (人声) / accompaniment (伴奏)
 * 支持 Range 请求
 */
router.get('/stream/:dir/:type', async (req, res) => {
  try {
    const dir = req.params.dir;
    const type = req.params.type;

    if (type !== 'vocals' && type !== 'accompaniment') {
      return res.status(400).json({ error: 'type 必须是 vocals 或 accompaniment' });
    }

    // 方案一：通过 cloud-drive 获取 302 直链（标准方案，支持多账号自动识别）
    const directUrl = await getCloudDirectUrl(dir, type);
    if (directUrl && directUrl.url) {
      console.log(`[NETKTV] 使用 cloud-drive 302 直链: ${dir}/${type}`);
      // 302 重定向到 115 CDN 直链
      res.setHeader('Location', directUrl.url);
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return res.status(302).send();
    }

    // 方案二：回退到直接从挂载路径读取文件（兼容模式）
    const fullPath = path.join(SEPARATED_DIR, dir);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: '歌曲不存在（挂载路径和 cloud-drive 均不可用）' });
    }

    const files = fs.readdirSync(fullPath);
    let fileName;
    if (type === 'vocals') {
      fileName = files.find((f) => f.includes('人声') || f.includes('vocals'));
    } else {
      fileName = files.find((f) => f.includes('伴奏') || f.includes('accompaniment'));
    }

    if (!fileName) {
      return res.status(404).json({ error: '文件不存在', type });
    }

    const filePath = path.join(fullPath, fileName);
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;

    // 处理 Range 请求
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'audio/flac',
        'Content-Disposition': `inline; filename="${encodeURIComponent(fileName)}"`,
      });

      const stream = fs.createReadStream(filePath, { start, end });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Accept-Ranges': 'bytes',
        'Content-Type': 'audio/flac',
        'Content-Disposition': `inline; filename="${encodeURIComponent(fileName)}"`,
      });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (e) {
    console.error('串流代理错误:', e);
    if (!res.headersSent) {
      res.status(500).json({ error: e.message });
    }
  }
});

module.exports = { router, init };
