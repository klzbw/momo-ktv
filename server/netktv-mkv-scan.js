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
 *   cloud_account_id - 所属 115 账号 ID（支持多账号）
 *
 * 多账号支持：
 *   - 扫描时写入 cloud_account_id，不同账号的同名歌曲可分别入库
 *   - API 不传 accountId（或传 0）时，自动遍历所有 active 账号扫描
 *
 * API：
 *   POST /api/netktv/mkv/scan — 触发扫描（body: { accountId, basePath, limit }）
 *   GET  /api/netktv/mkv/scan/status — 查询扫描状态
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
// feat(auto-scan): 自动识别扫描按扩展名判定视频/音频，复用 mediaFormats 的统一白名单
const { mediaTypeOf } = require('./mediaFormats');

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
 * 从媒体文件名提取歌手和歌名
 * feat(auto-scan): 原写死只剥 .mkv 后缀；改为剥离任意扩展名，
 * 让此解析对 mp4/flac/ape/iso 等任意媒体文件通用（.cue/.strm 不进此流程）。
 */
function parseMkvFilename(filename) {
  let name = filename.replace(/\.[a-z0-9]+$/i, '').trim();
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
 * 通过 cloud-drive API 扫描单个 115 账号上的 MKV 文件
 * @param {object} cloudDrive - cloud-drive 模块实例
 * @param {number} accountId - 115 账号 ID
 * @param {string} basePath - MKV 文件根目录，如 /ktv-output
 * @param {object} db - 数据库实例
 * @param {string} strmDir - [已废弃] STRM 文件输出目录，保留参数兼容旧调用
 * @param {number} limit - 限制扫描数量（0表示全部）
 */
// 递归收集目录下所有 MKV 文件（含子目录）
async function collectMkvFilesRecursive(driver, dirPath, basePath, depth = 0, maxDepth = 10) {
  if (depth > maxDepth) return [];
  const results = [];
  try {
    const items = await driver.listFiles(dirPath);
    for (const item of items) {
      if (item.isDir) {
        // 递归子目录
        const subPath = dirPath === '/' ? '/' + item.name : dirPath + '/' + item.name;
        const subFiles = await collectMkvFilesRecursive(driver, subPath, basePath, depth + 1, maxDepth);
        results.push(...subFiles);
      } else if (item.name.toLowerCase().endsWith('.mkv')) {
        // 计算相对于 basePath 的路径
        const relPath = dirPath.startsWith(basePath)
          ? dirPath.substring(basePath.length).replace(/^\//, '') + '/' + item.name
          : item.name;
        results.push({ ...item, relativePath: relPath.replace(/^\//, '') });
      }
    }
  } catch (e) {
    console.warn(`[NETKTV-MKV-SCAN] 递归扫描目录失败 ${dirPath}:`, e.message);
  }
  return results;
}

// feat(auto-scan): sibling 递归收集器——收集目录下所有可入库媒体实体文件
// （mediaTypeOf(ext)!==null 的视频+音频；.cue/.strm 索引/指针文件不算媒体实体，
//  不在这里收集），同时计算相对于 basePath 的 relativePath。
async function collectMediaFilesRecursive(driver, dirPath, basePath, depth = 0, maxDepth = 10) {
  if (depth > maxDepth) return [];
  const results = [];
  try {
    const items = await driver.listFiles(dirPath);
    for (const item of items) {
      if (item.isDir) {
        const subPath = dirPath === '/' ? '/' + item.name : dirPath + '/' + item.name;
        const subFiles = await collectMediaFilesRecursive(driver, subPath, basePath, depth + 1, maxDepth);
        results.push(...subFiles);
      } else {
        const ext = ('.' + String(item.name || '').split('.').pop()).toLowerCase();
        if (mediaTypeOf(ext) === null) continue; // 非视频/音频（含 cue/strm）跳过
        // 计算相对于 basePath 的路径（与 collectMkvFilesRecursive 同口径）
        const relPath = dirPath.startsWith(basePath)
          ? dirPath.substring(basePath.length).replace(/^\//, '') + '/' + item.name
          : item.name;
        results.push({ ...item, relativePath: relPath.replace(/^\//, ''), mediaExt: ext });
      }
    }
  } catch (e) {
    console.warn(`[NETKTV-AUTO-SCAN] 递归扫描目录失败 ${dirPath}:`, e.message);
  }
  return results;
}

async function scanMkvFiles(cloudDrive, accountId, basePath, db, strmDir, limit = 0, sourceRoot = 'netktv-mkv') {
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
      throw new Error(`网盘账号不存在: ${accountId}`);
    }
    const driver = manager.getDriver(account);

    console.log(`[NETKTV-MKV-SCAN] 开始递归扫描: ${basePath} (账号ID=${accountId}, 账号=${account.name}, sourceRoot=${sourceRoot})`);

    // 递归收集所有子目录中的 MKV 文件
    const allMkvFiles = await collectMkvFilesRecursive(driver, basePath, basePath);
    console.log(`[NETKTV-MKV-SCAN] 递归扫描完成，共找到 ${allMkvFiles.length} 个MKV文件（含子目录）`);

    let mkvFiles = allMkvFiles;
    if (limit > 0) {
      mkvFiles = mkvFiles.slice(0, limit);
    }

    scanStatus.total = mkvFiles.length;

    for (const fileInfo of mkvFiles) {
      const filename = fileInfo.name;
      scanStatus.currentFile = filename;
      scanStatus.processed++;

      try {
        const meta = parseMkvFilename(filename);

        // 检查是否已经入库（同一账号下同一 filename 不重复入库）
        const existing = db.prepare(`
          SELECT id FROM songs WHERE source_root = ? AND cloud_account_id = ? AND filename = ?
        `).get(
          sourceRoot,
          accountId,
          filename
        );

        if (existing) {
          scanStatus.skipped++;
          continue;
        }

        // 完整网盘路径（含 basePath 和子目录），播放时由 /api/cloud/direct/<accountId>/<filepath> 302 直连
        const fullPath = basePath.replace(/\/$/, '') + '/' + (fileInfo.relativePath || filename);

        // 入库（写入 cloud_account_id 支持多账号）
        const now = new Date().toISOString();
        const result = db.prepare(`
          INSERT INTO songs (title, artist, filename, filepath, source_root, is_network, is_strm, media_type, audio_tracks, cloud_account_id, duration, created_at)
          VALUES (?, ?, ?, ?, ?, 1, 1, 'video', 2, ?, ?, ?)
        `).run(
          meta.title,
          meta.artist,
          filename,           // 原始 MKV 文件名
          fullPath,           // 完整网盘路径（含 basePath 和子目录）
          sourceRoot,
          accountId,
          null, // duration 先留空：点歌/预热时由 ensureProbedOnDemand 用115直链ffprobe真实探测回写。旧版误写 size/1000 把字节数当秒(几十MB算出几万秒/几百分钟)污染进度条，已废弃。
          now
        );

        // 同步歌手到 song_artists 表（歌手点歌列表依赖此表，网盘扫描必须同步）
        db.prepare('INSERT OR IGNORE INTO song_artists (song_id, artist) VALUES (?, ?)').run(result.lastInsertRowid, meta.artist);

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
 * feat(auto-scan): 自动识别扫描——同一个网盘根目录下混有视频(mkv/mp4/iso...)与音频(flac/ape/dsf...)，
 * 不再要求管理员手动区分类型。入库字段口径与 scanMkvFiles 完全一致
 * (is_network=1, is_strm=1, cloud_account_id, filepath=完整网盘路径, duration 留 null, created_at,
 *  同步 song_artists)，去重口径相同(source_root + cloud_account_id + filename)；
 * 唯一差别是 media_type 按扩展名落位：视频→media_type='video', audio_tracks=2；
 * 音频→media_type='audio', audio_tracks=null。
 *
 * 与 scanMkvFiles 共用模块级 scanStatus（二者互斥触发，路由层已防重入）。
 */
async function scanAutoFiles(cloudDrive, accountId, basePath, db, strmDir, limit = 0, sourceRoot = 'netktv-mkv') {
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
      throw new Error(`网盘账号不存在: ${accountId}`);
    }
    const driver = manager.getDriver(account);

    console.log(`[NETKTV-AUTO-SCAN] 开始自动识别递归扫描: ${basePath} (账号ID=${accountId}, 账号=${account.name}, sourceRoot=${sourceRoot})`);

    // 递归收集所有视频+音频媒体实体文件（含子目录），不含 cue/strm
    const allMediaFiles = await collectMediaFilesRecursive(driver, basePath, basePath);
    console.log(`[NETKTV-AUTO-SCAN] 递归扫描完成，共找到 ${allMediaFiles.length} 个媒体文件（视频+音频，含子目录）`);

    let mediaFiles = allMediaFiles;
    if (limit > 0) {
      mediaFiles = mediaFiles.slice(0, limit);
    }

    scanStatus.total = mediaFiles.length;

    for (const fileInfo of mediaFiles) {
      const filename = fileInfo.name;
      scanStatus.currentFile = filename;
      scanStatus.processed++;

      try {
        const meta = parseMkvFilename(filename);
        // 按扩展名判定 media_type（白名单来自 mediaFormats）；音频 audio_tracks=null（走动态背景+AI对齐），视频沿用双音轨假设=2
        const mediaType = mediaTypeOf(fileInfo.mediaExt) || 'video';
        const audioTracks = mediaType === 'video' ? 2 : null;

        // 去重口径同 scanMkvFiles（同一 source_root + 账号 + 文件名不重复入库）
        const existing = db.prepare(`
          SELECT id FROM songs WHERE source_root = ? AND cloud_account_id = ? AND filename = ?
        `).get(
          sourceRoot,
          accountId,
          filename
        );

        if (existing) {
          scanStatus.skipped++;
          continue;
        }

        // 完整网盘路径（含 basePath 和子目录），播放时由 302 直连播放
        // （auto 来源 source_root=netktv-mkv-c<hash>，sep-info 按 startsWith('netktv-mkv-') 路由，零改动）
        const fullPath = basePath.replace(/\/$/, '') + '/' + (fileInfo.relativePath || filename);

        // 入库（media_type/audio_tracks 按扩展名落位，其余字段与 scanMkvFiles 一致）
        const now = new Date().toISOString();
        const result = db.prepare(`
          INSERT INTO songs (title, artist, filename, filepath, source_root, is_network, is_strm, media_type, audio_tracks, cloud_account_id, duration, created_at)
          VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)
        `).run(
          meta.title,
          meta.artist,
          filename,
          fullPath,
          sourceRoot,
          mediaType,
          audioTracks,
          accountId,
          null, // duration 留空：点歌/预热时由 ensureProbedOnDemand 真实探测回写（同 scanMkvFiles）
          now
        );

        // 同步歌手到 song_artists 表（同 scanMkvFiles）
        db.prepare('INSERT OR IGNORE INTO song_artists (song_id, artist) VALUES (?, ?)').run(result.lastInsertRowid, meta.artist);

        scanStatus.added++;

        if (scanStatus.added % 500 === 0) {
          console.log(`[NETKTV-AUTO-SCAN] 进度: ${scanStatus.processed}/${scanStatus.total} 新增: ${scanStatus.added}`);
        }

      } catch (e) {
        console.error(`[NETKTV-AUTO-SCAN] 处理 ${filename} 失败:`, e.message);
        scanStatus.errors.push({ file: filename, error: e.message });
      }
    }

    scanStatus.endTime = new Date();
    console.log(`[NETKTV-AUTO-SCAN] 扫描完成: 总计=${scanStatus.total} 新增=${scanStatus.added} 跳过=${scanStatus.skipped} 错误=${scanStatus.errors.length}`);

    // feat(auto-scan): 扫描收尾触发自动歌词流水线——其中 audio 走歌词对齐，
    // 视频(media_type='video')在该模块内会被自然跳过（它只处理 audio），无需在此额外过滤。
    try {
      require('./auto-lyrics').afterScanAutoLyrics(db, { limit: 100 });
    } catch (e) {
      console.warn('[NETKTV-AUTO-SCAN] afterScanAutoLyrics 触发失败(不影响入库):', e.message);
    }

  } catch (e) {
    console.error('[NETKTV-AUTO-SCAN] 扫描失败:', e);
    scanStatus.errors.push({ dir: basePath, error: e.message });
    scanStatus.endTime = new Date();
  } finally {
    scanStatus.running = false;
    scanStatus.currentFile = null;
  }

  return scanStatus;
}

/**
 * 遍历所有 active 账号逐一扫描 MKV（自动识别新账号）
 */
async function scanMkvAllAccounts(cloudDrive, basePath, db, strmDir, limit = 0) {
  const manager = cloudDrive.manager;
  const activeAccounts = manager.listAccounts().filter(a => a.status === 'active');
  console.log(`[NETKTV-MKV-SCAN] 自动识别到 ${activeAccounts.length} 个 active 账号，开始逐一扫描`);

  let totalAdded = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const account of activeAccounts) {
    console.log(`\n[NETKTV-MKV-SCAN] ===== 扫描账号: ${account.name} (ID=${account.id}) =====`);
    const result = await scanMkvFiles(cloudDrive, account.id, basePath, db, strmDir, limit);
    totalAdded += result.added;
    totalSkipped += result.skipped;
    totalErrors += result.errors.length;
  }

  console.log(`\n[NETKTV-MKV-SCAN] ===== 全部账号扫描完成: 新增=${totalAdded} 跳过=${totalSkipped} 错误=${totalErrors} =====`);
  return { totalAdded, totalSkipped, totalErrors, accountCount: activeAccounts.length };
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
  const DEFAULT_ACCOUNT_ID = parseInt(process.env.MKV_CLOUD_ACCOUNT_ID || '0', 10);
  const DEFAULT_BASE_PATH = process.env.MKV_BASE_PATH || '/ktv-output';

  // POST /api/netktv/mkv/scan — 触发扫描
  // body: { accountId, basePath, limit }
  // - accountId 不传或传 0：自动遍历所有 active 账号扫描（自动识别新账号）
  // - accountId 传具体数字：只扫描指定账号
  router.post('/mkv/scan', async (req, res) => {
    if (scanStatus.running) {
      return res.status(409).json({ error: '扫描正在进行中', status: scanStatus });
    }

    const { accountId = DEFAULT_ACCOUNT_ID, basePath = DEFAULT_BASE_PATH, limit = 0 } = req.body || {};

    if (!accountId || accountId === 0) {
      // 自动识别：遍历所有 active 账号
      scanMkvAllAccounts(cloudDrive, basePath, db, STRM_DIR, limit).catch(e => {
        console.error('[NETKTV-MKV-SCAN] 全账号扫描异常:', e);
      });
      res.json({ ok: true, message: '已开始遍历所有 active 账号扫描', mode: 'all-accounts' });
    } else {
      // 指定账号扫描
      scanMkvFiles(cloudDrive, accountId, basePath, db, STRM_DIR, limit).catch(e => {
        console.error('[NETKTV-MKV-SCAN] 异步扫描异常:', e);
      });
      res.json({ ok: true, message: '扫描已开始', status: scanStatus, accountId });
    }
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

module.exports = { init, router, scanMkvFiles, scanMkvAllAccounts, parseMkvFilename, migrateOldStrmData, scanAutoFiles };
