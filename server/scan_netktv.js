const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const db = new Database('/data/ktv.db');
const SEPARATED_DIR = '/data/cloud-115/separated';
const STRM_DIR = '/data/netktv-strm';
const STREAM_BASE = 'http://127.0.0.1:8080/api/netktv/stream';

// 创建 STRM 目录
if (!fs.existsSync(STRM_DIR)) fs.mkdirSync(STRM_DIR, { recursive: true });

console.log('=== 扫描 115 网盘分离文件 ===');
console.log('目录:', SEPARATED_DIR);

const dirs = fs.readdirSync(SEPARATED_DIR);
let added = 0;
let skipped = 0;
let failed = 0;

for (const dir of dirs) {
  const fullPath = path.join(SEPARATED_DIR, dir);
  if (!fs.statSync(fullPath).isDirectory()) continue;

  const files = fs.readdirSync(fullPath);
  const vocalFile = files.find(f => f.includes('人声') || f.includes('vocals'));
  const accompFile = files.find(f => f.includes('伴奏') || f.includes('accompaniment'));

  if (!vocalFile || !accompFile) {
    console.log(`跳过(不完整): ${dir}`);
    skipped++;
    continue;
  }

  // 从文件名提取歌手和歌名
  let artist = '未知';
  let title = vocalFile.replace(/(-人声|-vocals)\.flac$/i, '');
  if (title.includes('-')) {
    const parts = title.split('-');
    artist = parts[0].trim();
    title = parts.slice(1).join('-').trim();
  }

  // 生成唯一 filename
  const filename = `netktv_${dir}.strm`;

  // 检查是否已存在
  const existing = db.prepare('SELECT id FROM songs WHERE filename = ?').get(filename);
  if (existing) {
    console.log(`跳过(已存在): ${dir} - ${artist} - ${title}`);
    skipped++;
    continue;
  }

  try {
    // 生成人声 STRM 文件
    const vocalStrmPath = path.join(STRM_DIR, `${dir}_vocals.strm`);
    fs.writeFileSync(vocalStrmPath, `${STREAM_BASE}/${dir}/vocals\n`);

    // 生成伴奏 STRM 文件
    const accompStrmPath = path.join(STRM_DIR, `${dir}_accomp.strm`);
    fs.writeFileSync(accompStrmPath, `${STREAM_BASE}/${dir}/accompaniment\n`);

    // 生成拼音（简单处理，后续可以完善）
    const pinyin = title;

    // 入库
    const info = db.prepare(`
      INSERT INTO songs
        (title, artist, filename, filepath, duration, pinyin, audio_tracks,
         is_network, is_strm, media_type, sep_status, vocal_path, accomp_path, source_root)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 'audio', 'done', ?, ?, 'netktv')
    `).run(
      title, artist, filename, vocalStrmPath, null, pinyin, 2,
      vocalStrmPath, accompStrmPath
    );

    console.log(`入库成功: id=${info.lastInsertRowid} ${artist} - ${title}`);
    added++;
  } catch (e) {
    console.error(`入库失败: ${dir} - ${e.message}`);
    failed++;
  }
}

console.log('\n=== 扫描完成 ===');
console.log(`新增: ${added} 首`);
console.log(`跳过: ${skipped} 首`);
console.log(`失败: ${failed} 首`);

// 验证
const count = db.prepare("SELECT COUNT(*) as cnt FROM songs WHERE source_root = 'netktv'").get();
console.log(`\n网络KTV歌曲总数: ${count.cnt} 首`);

// 显示前5首
const songs = db.prepare("SELECT id, title, artist, filename FROM songs WHERE source_root = 'netktv' LIMIT 5").all();
console.log('\n前5首:');
songs.forEach(s => console.log(`  ${s.id}: ${s.artist} - ${s.title}`));

db.close();
