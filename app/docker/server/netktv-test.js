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
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const router = express.Router();

// 115 挂载路径（分离文件）
const SEPARATED_DIR = '/vol02/1000-1-fb5e5d14/momo-ktv/separated';

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
 * GET /api/netktv/stream/:dir/:type
 * 串流代理，直接从 115 挂载路径读取文件
 * type: vocals (人声) / accompaniment (伴奏)
 * 支持 Range 请求
 */
router.get('/stream/:dir/:type', (req, res) => {
  try {
    const dir = req.params.dir;
    const type = req.params.type;
    const fullPath = path.join(SEPARATED_DIR, dir);

    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: '歌曲不存在' });
    }

    const files = fs.readdirSync(fullPath);
    let fileName;
    if (type === 'vocals') {
      fileName = files.find((f) => f.includes('人声') || f.includes('vocals'));
    } else if (type === 'accompaniment') {
      fileName = files.find((f) => f.includes('伴奏') || f.includes('accompaniment'));
    } else {
      return res.status(400).json({ error: 'type 必须是 vocals 或 accompaniment' });
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

module.exports = router;
