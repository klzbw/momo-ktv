/**
 * 网络KTV MKV视频扫描模块
 * 通过 cloud-drive API 扫描 115 网盘上的 MKV 视频，直接入库（不生成本地STRM文件）
 *
 * 不依赖 NAS 挂载路径，只要有 cloud-drive 扫码登录就能使用。
 *
 * 入库字段说明：
 *   filename   - 原始 MKV 文件名，如 歌手-歌名.mkv
 *   filepath   - 115 网盘相对路径（相对于 Alist 挂载点 /115），如 ktv-output/歌手-歌名.mkv
 *                播放时由 /api/direct-stream/<filepath> 302 到 Alist，再到 115 CDN
 *   source_root - 'netktv-mkv'
 *   is_network  - 1
 *   is_strm     - 1（表示网络流歌曲，虽不生成本地.strm文件，但语义上仍是网络直连）
 *
 * API：
 *   POST /api/netktv/mkv/scan — 触发扫描（body: { accountId, basePath, limit }）
 *   GET  /api/netktv/mkv/scan/status — 查询扫描状态
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

// 扫描状态
let scanStatus = {
  running: false,
  total: 0,
  processed: 0,
  added: 0,
  skipped: 0,
  errors: [],
  currentFile: null,
  startTime: null,
  endTime: null,
};

/**
 * 从MKV文件名提取歌手和歌名
 */
function parseMkvFilename(filename) {
  let name = filename.replace(/\.mkv$/i, '').trim();
  let artist = '未知';
  let title = name;

  // 去掉语言标记
  name = name.replace(/\[(国语|粤语|台语|闽南语|英语|日语|韩语|双语)\]/gi, '').trim();
  // 去掉 (MTV) (演唱会) 等标记
  name = name.replace(/\((MTV|演唱会|现场|Live|KTV|MV)\)/gi, '').trim();
  // 去掉末尾的数字ID
  name = name.replace(/-\d{4,}$/, '').trim();

  // 按 "-" 分割
  const dashIdx = name.indexOf('-');
  if (dashIdx > 0) {
    const left = name.substring(0, dashIdx).trim();
    const right = name.substring(dashIdx + 1).trim();
    if (/^\d/.test(left)) {
      // 格式：序号 歌名 - 歌手
      const parts = left.split(/\s+/);
      if (parts.length >= 2) {
        title = parts.slice(1).join(' ').trim();
        artist = right;
      } else {
        artist = right;
        title = left;
      }
    } else {
      artist = left;
      title = right;
    }
  } else {
    const underscoreIdx = name.indexOf('_');
    if (underscoreIdx > 0) {
      artist = name.substring(0, underscoreIdx).trim();
      title = name.substring(underscoreIdx + 1).trim();
    }
  }

  artist = artist.replace(/\s+/g, ' ').trim();
  title = title.replace(/\s+/g, ' ').trim();
  if (!artist) artist = '未知';
  if (!title) title = name;

  return { artist, title };
}

/**
 * 通过 cloud-drive API 扫描 115 网盘上的 MKV 文件
 * @param {object} cloudDrive - cloud-drive 模块实例
 * @param {number} accountId - 115 账号 ID
 * @param {string} basePath - MKV 文件根目录，如 /ktv-output
 * @param {object} db - 数据库实例
 * @param {string} strmDir - [已废弃] STRM 文件输出目录，保留参数兼容旧调用
 * @param {number} limit - 限制扫描数量（0表示全部）
 */
async function scanMkvFiles(cloudDrive, accountId, basePath, db, strmDir, limit = 0) {
  scanStatus = {
    running: true,
    total: 0,
    processed: 0,
    added: 0,
    skipped: 0,
    errors: [],
    currentFile: null,
    startTime: new Date(),
    endTime: null,
  };

  try {
    const manager = cloudDrive.manager;
    const account = manager.getAccount(accountId);
    if (!account) {
      throw new Error(`115 账号不存在: ${accountId}`);
    }
    const driver = manager.getDriver(account);

    console.log(`[NETKTV-MKV-SCAN] 开始扫描: ${basePath} (账号ID=${accountId})`);

    // 通过 API 列出目录下所有文件（内部已支持分页）
    const allFiles = await driver.listFiles(basePath);
    console.log(`[NETKTV-MKV-SCAN] API 返回 ${allFiles.length} 个条目`);

    // 筛选 MKV 文件
    let mkvFiles = allFiles.filter(f => !f.isDir && f.name.toLowerCase().endsWith('.mkv'));
    if (limit > 0) {
      mkvFiles = mkvFiles.slice(0, limit);
    }

    scanStatus.total = mkvFiles.length;
    console.log(`[NETKTV-MKV-SCAN] 找到 ${mkvFiles.length} 个MKV文件`);

    // basePath 去掉前导 /，用于拼接相对路径
    // 如 /ktv-output → ktv-output，最终 filepath = ktv-output/xxx.mkv
    const relativeBase = basePath.replace(/^\//, '');

    for (const fileInfo of mkvFiles) {
      const filename = fileInfo.name;
      scanStatus.currentFile = filename;
      scanStatus.processed++;

      try {
        const meta = parseMkvFilename(filename);
        // 用 pickCode 作为唯一标识（115每个文件都有唯一pickCode）
        const songKey = fileInfo.pickCode || Buffer.from(filename).toString('hex').substring(0, 16);

        // 检查是否已经入库（兼容新旧两种 filename 格式）
        // 新格式：原始 MKV 文件名，如 歌手-歌名.mkv
        // 旧格式：netktv_mkv_<songKey>.strm（旧版扫描生成的STRM文件名）
        const existing = db.prepare(`
          SELECT id FROM songs WHERE source_root = ? AND (filename = ? OR filename = ?)
        `).get(
          'netktv-mkv',
          filename,
          `netktv_mkv_${songKey}.strm`
        );

        if (existing) {
          scanStatus.skipped++;
          continue;
        }

        // 115 网盘相对路径（相对于 Alist 挂载点 /115）
        // 播放时由 /api/direct-stream/<filepath> 302 到 Alist → 115 CDN
        const relativePath = relativeBase ? `${relativeBase}/${filename}` : filename;

        // 入库（不再生成本地 STRM 文件，filepath 直接存 115 相对路径）
        const now = new Date().toISOString();
        const result = db.prepare(`
          INSERT INTO songs (title, artist, filename, filepath, source_root, is_network, is_strm, media_type, audio_tracks, duration, created_at)
          VALUES (?, ?, ?, ?, ?, 1, 1, 'video', 2, ?, ?)
        `).run(
          meta.title,
          meta.artist,
          filename,           // 原始 MKV 文件名
          relativePath,       // 115 相对路径，如 ktv-output/xxx.mkv
          'netktv-mkv',
          fileInfo.size ? Math.round(fileInfo.size / 1000) : null, // 粗略估算时长（按1MB≈1秒）
          now
        );

        scanStatus.added++;

        if (scanStatus.added % 500 === 0) {
          console.log(`[NETKTV-MKV-SCAN] 进度: ${scanStatus.processed}/${scanStatus.total} 新增: ${scanStatus.added}`);
        }

      } catch (e) {
        console.error(`[NETKTV-MKV-SCAN] 处理 ${filename} 失败:`, e.message);
        scanStatus.errors.push({ file: filename, error: e.message });
      }
    }

    scanStatus.endTime = new Date();
    console.log(`[NETKTV-MKV-SCAN] 扫描完成: 总计=${scanStatus.total} 新增=${scanStatus.added} 跳过=${scanStatus.skipped} 错误=${scanStatus.errors.length}`);

  } catch (e) {
    console.error('[NETKTV-MKV-SCAN] 扫描失败:', e);
    scanStatus.errors.push({ dir: basePath, error: e.message });
    scanStatus.endTime = new Date();
  } finally {
    scanStatus.running = false;
    scanStatus.currentFile = null;
  }

  return scanStatus;
}

/**
 * 迁移旧数据：将旧版扫描入库的 netktv-mkv 歌曲从"本地STRM路径"迁移为"115相对路径"
 * 旧数据特征：filename LIKE 'netktv_mkv_%.strm'，filepath 是本地 .strm 文件路径
 * 迁移逻辑：读取 .strm 文件内容，从中解析出原始 MKV 文件名，更新 filepath 和 filename
 *
 * @param {object} db - 数据库实例
 * @param {string} defaultBasePath - 默认的 115 基础路径，如 ktv-output
 * @returns {object} 迁移结果统计
 */
async function migrateOldStrmData(db, defaultBasePath = 'ktv-output') {
  const result = { total: 0, migrated: 0, skipped: 0, failed: 0, errors: [] };

  try {
    // 查询旧格式数据
    const oldSongs = db.prepare(`
      SELECT id, filename, filepath FROM songs
      WHERE source_root = 'netktv-mkv' AND filename LIKE 'netktv_mkv_%.strm'
    `).all();

    result.total = oldSongs.length;
    console.log(`[NETKTV-MKV-MIGRATE] 找到 ${oldSongs.length} 条旧格式数据需要迁移`);

    for (const song of oldSongs) {
      try {
        // 读取 STRM 文件内容
        if (!fs.existsSync(song.filepath)) {
          result.skipped++;
          result.errors.push({ id: song.id, error: `STRM文件不存在: ${song.filepath}` });
          continue;
        }

        const strmContent = fs.readFileSync(song.filepath, 'utf-8').trim();
        // STRM 内容格式: http://127.0.0.1:8080/api/cloud/stream-path/<accountId>/ktv-output/<encodedFilename>
        const match = strmContent.match(/\/ktv-output\/([^/\s]+)$/);
        if (!match) {
          result.skipped++;
          result.errors.push({ id: song.id, error: `无法从STRM内容解析文件名: ${strmContent}` });
          continue;
        }

        const encodedFilename = match[1];
        const originalFilename = decodeURIComponent(encodedFilename);
        const relativePath = `${defaultBasePath}/${originalFilename}`;

        // 更新数据库
        db.prepare(`
          UPDATE songs SET filename = ?, filepath = ? WHERE id = ?
        `).run(originalFilename, relativePath, song.id);

        result.migrated++;
        console.log(`[NETKTV-MKV-MIGRATE] 迁移成功: id=${song.id} ${originalFilename}`);

      } catch (e) {
        result.failed++;
        result.errors.push({ id: song.id, error: e.message });
        console.error(`[NETKTV-MKV-MIGRATE] 迁移失败 id=${song.id}:`, e.message);
      }
    }

    console.log(`[NETKTV-MKV-MIGRATE] 迁移完成: 总计=${result.total} 成功=${result.migrated} 跳过=${result.skipped} 失败=${result.failed}`);

  } catch (e) {
    console.error('[NETKTV-MKV-MIGRATE] 迁移异常:', e);
    result.errors.push({ error: e.message });
  }

  return result;
}

/**
 * 初始化模块
 */
function init(db, cloudDrive) {
  const DATA_DIR = process.env.DATA_DIR || '/data';
  const STRM_DIR = path.join(DATA_DIR, 'netktv-mkv-strm');
  const DEFAULT_ACCOUNT_ID = parseInt(process.env.MKV_CLOUD_ACCOUNT_ID || '2', 10);
  const DEFAULT_BASE_PATH = process.env.MKV_BASE_PATH || '/ktv-output';

  // POST /api/netktv/mkv/scan — 触发扫描
  router.post('/mkv/scan', async (req, res) => {
    if (scanStatus.running) {
      return res.status(409).json({ error: '扫描正在进行中', status: scanStatus });
    }

    const { accountId = DEFAULT_ACCOUNT_ID, basePath = DEFAULT_BASE_PATH, limit = 0 } = req.body || {};

    scanMkvFiles(cloudDrive, accountId, basePath, db, STRM_DIR, limit).catch(e => {
      console.error('[NETKTV-MKV-SCAN] 异步扫描异常:', e);
    });

    res.json({ ok: true, message: '扫描已开始', status: scanStatus });
  });

  // GET /api/netktv/mkv/scan/status — 查询扫描状态
  router.get('/mkv/scan/status', (req, res) => {
    res.json(scanStatus);
  });

  // POST /api/netktv/mkv/migrate — 迁移旧版STRM数据到新格式（115相对路径）
  router.post('/mkv/migrate', async (req, res) => {
    const { basePath = 'ktv-output' } = req.body || {};
    try {
      const result = await migrateOldStrmData(db, basePath);
      res.json({ ok: true, result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { init, router, scanMkvFiles, parseMkvFilename, migrateOldStrmData };
