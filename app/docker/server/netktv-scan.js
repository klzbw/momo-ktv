/**
 * 网络 KTV 标准扫描模块
 * 通过 cloud-drive 模块扫描 115 网盘上的分离文件，生成 STRM 文件并入库
 *
 * 与 netktv-test.js 的区别：
 * - netktv-test.js 直接从 NAS 挂载路径读取文件（依赖挂载）
 * - netktv-scan.js 通过 cloud-drive 的 302 直链 API 获取文件（不依赖挂载，标准方案）
 *
 * 115 分离文件目录结构：
 *   /momo-ktv/separated/<sha256前16位>/<歌手>-<歌名>-人声.flac
 *   /momo-ktv/separated/<sha256前16位>/<歌手>-<歌名>-伴奏.flac
 *
 * API：
 *   POST /api/netktv/scan — 触发扫描（body: { accountId, basePath }）
 *   GET  /api/netktv/scan/status — 查询扫描状态
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
 * 从文件名提取歌手和歌名
 * 格式：<歌手>-<歌名>-人声.flac 或 <歌手>-<歌名>-伴奏.flac
 */
function parseFilename(filename) {
  // 去掉后缀
  let name = filename.replace(/\.(flac|wav|mp3|m4a)$/i, '');
  // 去掉 -人声 / -伴奏 / -vocals / -accompaniment 后缀
  name = name.replace(/-(人声|伴奏|vocals|accompaniment|instrumental)$/i, '');

  let artist = '未知';
  let title = name;

  // 尝试按第一个 "-" 分割歌手和歌名
  const idx = name.indexOf('-');
  if (idx > 0) {
    artist = name.substring(0, idx).trim();
    title = name.substring(idx + 1).trim();
  }

  return { artist, title };
}

/**
 * 判断文件是否是人声音频
 */
function isVocalFile(filename) {
  return /(人声|vocal|vocals|原唱)/i.test(filename) && /\.(flac|wav|mp3|m4a)$/i.test(filename);
}

/**
 * 判断文件是否是伴奏音频
 */
function isAccompFile(filename) {
  return /(伴奏|accomp|accompaniment|instrumental|纯音乐)/i.test(filename) && /\.(flac|wav|mp3|m4a)$/i.test(filename);
}

/**
 * 扫描 115 网盘上的分离文件
 * @param {object} cloudDrive - cloud-drive 模块实例
 * @param {number} accountId - 115 账号 ID
 * @param {string} basePath - 分离文件根目录，如 /momo-ktv/separated
 * @param {object} db - 数据库实例
 * @param {string} strmDir - STRM 文件输出目录
 */
async function scanSeparatedFiles(cloudDrive, accountId, basePath, db, strmDir) {
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
    // 获取驱动实例
    const manager = cloudDrive.manager;
    const account = manager.getAccount(accountId);
    if (!account) {
      throw new Error(`115 账号不存在: ${accountId}`);
    }
    const driver = manager.getDriver(account);

    // 列出根目录下的所有歌曲目录
    console.log(`[NETKTV-SCAN] 开始扫描: ${basePath}`);
    const rootFiles = await driver.listFiles(basePath);
    console.log(`[NETKTV-SCAN] 根目录下有 ${rootFiles.length} 个条目`);

    // 筛选出目录（115 API 可能把目录也返回为文件，isDir 可能不准确）
    const songDirs = rootFiles.filter(f => {
      // 目录名应该是 16 位十六进制（sha256 前16位）
      return /^[a-f0-9]{16}$/i.test(f.name);
    });

    scanStatus.total = songDirs.length;
    console.log(`[NETKTV-SCAN] 找到 ${songDirs.length} 个歌曲目录`);

    // 确保 STRM 目录存在
    if (!fs.existsSync(strmDir)) {
      fs.mkdirSync(strmDir, { recursive: true });
    }

    // 遍历每个歌曲目录
    for (const dirInfo of songDirs) {
      scanStatus.currentFile = dirInfo.name;
      scanStatus.processed++;

      try {
        const dirPath = `${basePath}/${dirInfo.name}`;
        const files = await driver.listFiles(dirPath);

        // 查找人声和伴奏文件
        const vocalFile = files.find(f => isVocalFile(f.name));
        const accompFile = files.find(f => isAccompFile(f.name));

        if (!vocalFile || !accompFile) {
          console.log(`[NETKTV-SCAN] 跳过 ${dirInfo.name}: 人声=${!!vocalFile} 伴奏=${!!accompFile}`);
          scanStatus.skipped++;
          continue;
        }

        // 解析文件名获取歌手和歌名
        const meta = parseFilename(vocalFile.name);
        const songKey = dirInfo.name; // 用目录名作为唯一标识

        // 检查是否已经入库
        const existing = db.prepare('SELECT id FROM songs WHERE source_root = ? AND filepath LIKE ?').get(
          'netktv',
          `%${songKey}_vocals.strm%`
        );

        if (existing) {
          console.log(`[NETKTV-SCAN] 已存在: ${meta.artist} - ${meta.title} (id=${existing.id})`);
          scanStatus.skipped++;
          continue;
        }

        // 生成 STRM 文件
        // STRM 内容指向 netktv 串流代理（代理内部通过 cloud-drive 获取 302 直链）
        const vocalStrmPath = path.join(strmDir, `${songKey}_vocals.strm`);
        const accompStrmPath = path.join(strmDir, `${songKey}_accomp.strm`);

        const vocalStrmContent = `http://127.0.0.1:8080/api/netktv/stream/${songKey}/vocals\n`;
        const accompStrmContent = `http://127.0.0.1:8080/api/netktv/stream/${songKey}/accompaniment\n`;

        fs.writeFileSync(vocalStrmPath, vocalStrmContent);
        fs.writeFileSync(accompStrmPath, accompStrmContent);

        // 入库
        const now = new Date().toISOString();
        const result = db.prepare(`
          INSERT INTO songs (title, artist, filepath, vocal_path, accomp_path, source_root, is_network, is_strm, duration, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)
        `).run(
          meta.title,
          meta.artist,
          vocalStrmPath,
          vocalStrmPath,
          accompStrmPath,
          'netktv',
          null, // duration 暂时为空，播放时探测
          now,
          now
        );

        console.log(`[NETKTV-SCAN] 新增: ${meta.artist} - ${meta.title} (id=${result.lastInsertRowid})`);
        scanStatus.added++;

        // 限速：避免请求过快被 115 风控
        await new Promise(resolve => setTimeout(resolve, 200));

      } catch (e) {
        console.error(`[NETKTV-SCAN] 处理 ${dirInfo.name} 失败:`, e.message);
        scanStatus.errors.push({ dir: dirInfo.name, error: e.message });
      }
    }

    scanStatus.endTime = new Date();
    console.log(`[NETKTV-SCAN] 扫描完成: 总计=${scanStatus.total} 新增=${scanStatus.added} 跳过=${scanStatus.skipped} 错误=${scanStatus.errors.length}`);

  } catch (e) {
    console.error('[NETKTV-SCAN] 扫描失败:', e);
    scanStatus.errors.push({ dir: 'ROOT', error: e.message });
    scanStatus.endTime = new Date();
  } finally {
    scanStatus.running = false;
    scanStatus.currentFile = null;
  }

  return scanStatus;
}

/**
 * 初始化模块
 * @param {object} db - 数据库实例
 * @param {object} cloudDrive - cloud-drive 模块实例
 */
function init(db, cloudDrive) {
  const DATA_DIR = process.env.DATA_DIR || '/data';
  const STRM_DIR = path.join(DATA_DIR, 'netktv-strm');

  // POST /api/netktv/scan — 触发扫描
  router.post('/scan', async (req, res) => {
    if (scanStatus.running) {
      return res.status(409).json({ error: '扫描正在进行中', status: scanStatus });
    }

    const { accountId = 1, basePath = '/momo-ktv/separated' } = req.body || {};

    // 异步执行扫描
    scanSeparatedFiles(cloudDrive, accountId, basePath, db, STRM_DIR).catch(e => {
      console.error('[NETKTV-SCAN] 异步扫描异常:', e);
    });

    res.json({ ok: true, message: '扫描已开始', status: scanStatus });
  });

  // GET /api/netktv/scan/status — 查询扫描状态
  router.get('/scan/status', (req, res) => {
    res.json(scanStatus);
  });

  return router;
}

module.exports = { init, router, scanSeparatedFiles, parseFilename };
