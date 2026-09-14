/**
 * P2: 数据库时长脏数据修正脚本
 *
 * 问题：旧扫描入库歌曲 duration 字段存的是文件字节数（如 40000000）不是真实秒数。
 * 修复：
 *   1. 扫描所有 duration > 36000 的歌曲（超过10小时即脏数据）
 *   2. 本地文件用 ffprobe 探测真实时长
 *   3. 网盘文件暂时置 NULL（点播时再探测）
 *   4. 更新 songs 表 duration 字段
 *
 * 用法：在 NAS 容器内执行  node /app/server/fix-duration.js
 */
const Database = require('better-sqlite3');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || '/data';
const DB_PATH = path.join(DATA_DIR, 'ktv.db');

const DIRTY_THRESHOLD = 36000; // 10小时，超过即视为脏数据

function ffprobeDuration(filepath) {
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      filepath,
    ], { timeout: 30000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const seconds = parseFloat(String(stdout).trim());
      if (!isFinite(seconds) || seconds <= 0) { resolve(null); return; }
      resolve(Math.round(seconds));
    });
  });
}

async function main() {
  console.log('=== P2: 时长脏数据修正 ===');
  console.log('数据库:', DB_PATH);
  console.log('脏数据阈值: duration >', DIRTY_THRESHOLD, '秒 (', (DIRTY_THRESHOLD/3600).toFixed(1), '小时)');
  console.log('');

  if (!fs.existsSync(DB_PATH)) {
    console.error('数据库文件不存在:', DB_PATH);
    process.exit(1);
  }

  const db = new Database(DB_PATH);

  // 1. 查询所有脏数据
  const dirtySongs = db.prepare(
    'SELECT id, title, artist, filename, filepath, duration, source_type FROM songs WHERE duration > ? ORDER BY duration DESC'
  ).all(DIRTY_THRESHOLD);

  console.log('发现脏数据歌曲:', dirtySongs.length, '首');
  console.log('');

  if (dirtySongs.length === 0) {
    console.log('没有需要修正的脏数据，退出。');
    db.close();
    return;
  }

  // 统计分类
  let localCount = 0;
  let cloudCount = 0;
  let fixedCount = 0;
  let failedCount = 0;
  let cloudNullCount = 0;

  const updateStmt = db.prepare('UPDATE songs SET duration = ? WHERE id = ?');

  for (let i = 0; i < dirtySongs.length; i++) {
    const song = dirtySongs[i];
    const isCloud = song.source_type === 'cloud';

    if (isCloud) {
      // 网盘文件：置 NULL，点播时再探测
      cloudCount++;
      updateStmt.run(null, song.id);
      cloudNullCount++;
      console.log(`[${i + 1}/${dirtySongs.length}] 网盘 -> NULL  id=${song.id} ${song.title} (旧值=${song.duration})`);
      continue;
    }

    // 本地文件：ffprobe 探测
    localCount++;
    const realDuration = await ffprobeDuration(song.filepath);

    if (realDuration !== null) {
      updateStmt.run(realDuration, song.id);
      fixedCount++;
      console.log(`[${i + 1}/${dirtySongs.length}] 本地 -> ${realDuration}s  id=${song.id} ${song.title} (旧值=${song.duration} 路径=${song.filepath})`);
    } else {
      failedCount++;
      // 探测失败也置 NULL，避免保留错误值
      updateStmt.run(null, song.id);
      console.log(`[${i + 1}/${dirtySongs.length}] 本地 -> 探测失败置 NULL  id=${song.id} ${song.title} (旧值=${song.duration} 路径=${song.filepath})`);
    }

    // 每 50 首让出一次事件循环
    if (i % 50 === 0) {
      await new Promise(r => setTimeout(r, 0));
    }
  }

  console.log('');
  console.log('=== 修正完成 ===');
  console.log('总计脏数据:', dirtySongs.length);
  console.log('  本地文件:', localCount, '(成功探测:', fixedCount, ', 失败置NULL:', failedCount, ')');
  console.log('  网盘文件:', cloudCount, '(已置NULL，待点播探测:', cloudNullCount, ')');
  console.log('');

  // 2. 验证：随机查几首修正后的歌曲
  console.log('=== 验证：抽查几首修正后的歌曲 ===');
  const verifySongs = db.prepare(
    'SELECT id, title, duration, source_type FROM songs WHERE duration IS NOT NULL AND duration <= ? ORDER BY RANDOM() LIMIT 5'
  ).all(DIRTY_THRESHOLD);
  for (const s of verifySongs) {
    console.log(`  id=${s.id}  ${s.title}  duration=${s.duration}s (${Math.floor(s.duration/60)}:${String(s.duration%60).padStart(2,'0')})  source=${s.source_type || 'local'}`);
  }

  // 3. 确认没有残留脏数据
  const remaining = db.prepare('SELECT COUNT(*) as n FROM songs WHERE duration > ?').get(DIRTY_THRESHOLD);
  console.log('');
  console.log('残留脏数据 (duration > ' + DIRTY_THRESHOLD + '):', remaining.n, '首');

  // 4. 统计 NULL 数量
  const nullCount = db.prepare('SELECT COUNT(*) as n FROM songs WHERE duration IS NULL').get();
  console.log('duration 为 NULL (待探测):', nullCount.n, '首');

  db.close();
  console.log('');
  console.log('P2 修正脚本执行完毕。');
}

main().catch(e => {
  console.error('脚本执行失败:', e);
  process.exit(1);
});
