// 「曲库管理 - 自动清理」：整合 separated 人声分离产物缓存、损坏文件检测、
// 孤儿记录清理、分离任务历史清理四大功能。
//
// 背景：
//   - HLS 转码缓存已有 cacheCleaner.js 管理，但 separated/ 目录下的 AI 人声
//     分离产物（每首歌 vocals.wav + accompaniment.wav，约 700MB-800MB/首）
//     完全没有清理机制，长期积累会占用上百 GB 磁盘空间。
//   - 扫描时 ffprobe 探测失败的文件会被标记为 audio_tracks=NULL 下次重试，
//     但如果文件本身已经损坏（不是临时网络抖动），会一直重试一直失败，
//     需要一个"连续失败 N 次后标记为损坏"的机制。
//   - 孤儿记录（数据库里有但磁盘上文件已不存在）虽然目前有来源级别的清理，
//     但缺少文件级别的自动检测。
//   - separation_jobs 表的 failed 任务会一直累积，需要定期清理历史。
//
// 策略（跟 cacheCleaner.js 保持一致的设计风格）：
//   1) separated 缓存：支持按存储空间限额 / 按点歌时间两种策略，管理员可切换
//   2) 损坏文件：扫描时 ffprobe 连续失败超过阈值的歌曲自动标记，管理员可预览/删除
//   3) 孤儿记录：每日自动检测文件不存在的歌曲，记录但不自动删除（需管理员确认）
//   4) 分离任务：自动清理超过 30 天的 failed 任务记录
const fs = require('fs');
const path = require('path');
const db = require('./db');
const log = require('./logger');

const DATA_DIR = process.env.DATA_DIR || '/data';
const SEP_DIR = path.join(DATA_DIR, 'separated');

// ---------- settings 读写 ----------
const SEP_MODE_KEY = 'sep_cleanup_mode';       // 'size' | 'time'
const SEP_SIZE_LIMIT_KEY = 'sep_size_limit_gb';
const SEP_TIME_DAYS_KEY = 'sep_time_days';
const DAMAGE_THRESHOLD_KEY = 'damage_probe_threshold'; // 连续探测失败次数阈值
const ORPHAN_AUTO_DELETE_KEY = 'orphan_auto_delete';   // '1' | '0'

const DEFAULT_SEP_MODE = 'size';
const DEFAULT_SEP_SIZE_LIMIT_GB = 100;  // 默认 100GB 限额
const DEFAULT_SEP_TIME_DAYS = 90;       // 默认 90 天未点唱则清理分离产物
const DEFAULT_DAMAGE_THRESHOLD = 5;     // 连续探测失败 5 次标记为损坏

function getSettingRaw(key) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  } catch (e) { return null; }
}
function setSettingRaw(key, value) {
  try {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String(value));
  } catch (e) { log.error('AUTO_CLEAN', `设置保存失败 key=${key}: ${e.message}`); }
}

function getSepSettings() {
  const modeRaw = getSettingRaw(SEP_MODE_KEY);
  const sizeRaw = Number(getSettingRaw(SEP_SIZE_LIMIT_KEY));
  const timeRaw = Number(getSettingRaw(SEP_TIME_DAYS_KEY));
  return {
    mode: (modeRaw === 'size' || modeRaw === 'time') ? modeRaw : DEFAULT_SEP_MODE,
    sizeLimitGB: Number.isFinite(sizeRaw) && sizeRaw > 0 ? sizeRaw : DEFAULT_SEP_SIZE_LIMIT_GB,
    timeDays: Number.isFinite(timeRaw) && timeRaw > 0 ? timeRaw : DEFAULT_SEP_TIME_DAYS,
  };
}
function saveSepSettings({ mode, sizeLimitGB, timeDays }) {
  if (mode === 'size' || mode === 'time') setSettingRaw(SEP_MODE_KEY, mode);
  if (Number.isFinite(sizeLimitGB) && sizeLimitGB > 0) setSettingRaw(SEP_SIZE_LIMIT_KEY, sizeLimitGB);
  if (Number.isFinite(timeDays) && timeDays > 0) setSettingRaw(SEP_TIME_DAYS_KEY, timeDays);
  return getSepSettings();
}

function getDamageThreshold() {
  const v = Number(getSettingRaw(DAMAGE_THRESHOLD_KEY));
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_DAMAGE_THRESHOLD;
}
function setDamageThreshold(n) {
  if (Number.isFinite(n) && n >= 1) setSettingRaw(DAMAGE_THRESHOLD_KEY, Math.round(n));
}

// ---------- 工具函数 ----------
function dirSize(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return 0; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += dirSize(full);
      else total += fs.statSync(full).size;
    } catch (e) { /* 忽略单个文件读取失败 */ }
  }
  return total;
}

function lastRequestTime(songId) {
  try {
    const h = db.prepare('SELECT MAX(played_at) t FROM history WHERE song_id = ?').get(songId);
    if (h && h.t) return new Date(h.t).getTime();
  } catch (e) {}
  try {
    const q = db.prepare('SELECT MAX(created_at) t FROM queue WHERE song_id = ?').get(songId);
    if (q && q.t) return new Date(q.t).getTime();
  } catch (e) {}
  return null;
}

// ---------- separated 缓存清理 ----------
function listSepEntries() {
  if (!fs.existsSync(SEP_DIR)) return [];
  let dirs;
  try { dirs = fs.readdirSync(SEP_DIR, { withFileTypes: true }); }
  catch (e) { log.error('AUTO_CLEAN', `读取 separated 目录失败: ${e.message}`); return []; }
  const entries = [];
  for (const d of dirs) {
    if (!d.isDirectory() || !/^\d+$/.test(d.name)) continue;
    const id = Number(d.name);
    const full = path.join(SEP_DIR, d.name);
    let mtime = 0;
    try { mtime = fs.statSync(full).mtimeMs; } catch (e) {}
    const song = db.prepare('SELECT id, title, artist FROM songs WHERE id = ?').get(id);
    const reqTime = lastRequestTime(id);
    entries.push({
      id,
      dir: full,
      size: dirSize(full),
      time: reqTime != null ? reqTime : mtime,
      songExists: !!song,
      title: song ? song.title : null,
      artist: song ? song.artist : null,
    });
  }
  return entries;
}

function removeSepEntry(entry, reason) {
  try {
    fs.rmSync(entry.dir, { recursive: true, force: true });
    // 清理 songs 表中的分离产物路径引用
    try {
      db.prepare('UPDATE songs SET vocal_path=NULL, accomp_path=NULL, sep_status=NULL WHERE id=?').run(entry.id);
    } catch (e) { /* 列可能不存在，忽略 */ }
    log.info('AUTO_CLEAN', `[歌曲 id=${entry.id}] separated 分离产物已清理(约 ${(entry.size / 1073741824).toFixed(2)}GB)，原因: ${reason}`);
    return true;
  } catch (e) {
    log.error('AUTO_CLEAN', `[歌曲 id=${entry.id}] separated 清理失败: ${e.message}`);
    return false;
  }
}

// 孤儿分离产物：对应歌曲已不在曲库中
function cleanupSepOrphans() {
  const entries = listSepEntries().filter(e => !e.songExists);
  let removed = 0, freed = 0;
  for (const e of entries) {
    if (removeSepEntry(e, '对应歌曲已不在曲库中(孤儿分离产物)')) { removed++; freed += e.size; }
  }
  return { removed, freed };
}

function cleanupSepBySize(limitGB) {
  const limitBytes = limitGB * 1024 * 1024 * 1024;
  const entries = listSepEntries().filter(e => e.songExists);
  entries.sort((a, b) => a.time - b.time);
  const totalBefore = entries.reduce((s, e) => s + e.size, 0);
  let total = totalBefore;
  let removed = 0, freed = 0;
  for (const e of entries) {
    if (total <= limitBytes) break;
    if (removeSepEntry(e, `separated 总量(约${(totalBefore / 1073741824).toFixed(1)}GB)超出限额 ${limitGB}GB，清理最早点唱过的分离产物`)) {
      total -= e.size; freed += e.size; removed++;
    }
  }
  return { removed, freed, totalBefore, totalAfter: total };
}

function cleanupSepByTime(days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const entries = listSepEntries().filter(e => e.songExists);
  let removed = 0, freed = 0;
  for (const e of entries) {
    if (e.time < cutoff) {
      if (removeSepEntry(e, `距上次点唱已超过 ${days} 天`)) { removed++; freed += e.size; }
    }
  }
  return { removed, freed };
}

function runSepCleanup() {
  const orphan = cleanupSepOrphans();
  const settings = getSepSettings();
  const modeResult = settings.mode === 'size'
    ? cleanupSepBySize(settings.sizeLimitGB)
    : cleanupSepByTime(settings.timeDays);
  return { mode: settings.mode, orphan, ...modeResult };
}

function cleanupSepAll() {
  const entries = listSepEntries().filter(e => e.songExists);
  let removed = 0, freed = 0;
  for (const e of entries) {
    if (removeSepEntry(e, '管理员手动清理全部分离产物')) { removed++; freed += e.size; }
  }
  return { removed, freed };
}

function getSepStats() {
  const entries = listSepEntries();
  const totalSize = entries.reduce((s, e) => s + e.size, 0);
  const orphanCount = entries.filter(e => !e.songExists).length;
  return { count: entries.length, totalSize, orphanCount, ...getSepSettings() };
}

// ---------- 损坏文件检测 ----------
// 探测失败计数器：song_id -> 连续失败次数（内存中，重启后重置；
// 持久化的"已标记损坏"状态存 songs.damage_flag）
const probeFailCount = new Map();

function registerProbeFailure(songId) {
  const count = (probeFailCount.get(songId) || 0) + 1;
  probeFailCount.set(songId, count);
  const threshold = getDamageThreshold();
  if (count >= threshold) {
    try {
      db.prepare('UPDATE songs SET damage_flag=1 WHERE id=? AND (damage_flag IS NULL OR damage_flag=0)').run(songId);
      log.warn('AUTO_CLEAN', `[歌曲 id=${songId}] 连续探测失败 ${count} 次，已标记为损坏文件`);
    } catch (e) { /* damage_flag 列可能不存在，忽略 */ }
  }
  return count;
}

function resetProbeFailure(songId) {
  probeFailCount.delete(songId);
}

// 扫描数据库中标记为损坏的歌曲
function getDamagedSongs(limit = 100) {
  try {
    return db.prepare('SELECT id, title, artist, filename, filepath FROM songs WHERE damage_flag=1 ORDER BY id DESC LIMIT ?').all(limit);
  } catch (e) {
    return []; // damage_flag 列不存在时返回空
  }
}

function getDamagedCount() {
  try {
    return db.prepare('SELECT COUNT(*) c FROM songs WHERE damage_flag=1').get().c;
  } catch (e) { return 0; }
}

// 取消损坏标记（文件修复后重新扫描）
function clearDamageFlag(ids) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  const placeholders = ids.map(() => '?').join(',');
  try {
    const r = db.prepare(`UPDATE songs SET damage_flag=0 WHERE id IN (${placeholders})`).run(...ids);
    ids.forEach(id => probeFailCount.delete(id));
    return r.changes;
  } catch (e) { return 0; }
}

// 删除损坏歌曲（级联删除）
function deleteDamagedSongs(ids, deleteSongCascadeFn) {
  if (!Array.isArray(ids) || !ids.length) return { deleted: 0, failed: 0 };
  let deleted = 0, failed = 0;
  for (const id of ids) {
    try {
      if (typeof deleteSongCascadeFn === 'function') {
        deleteSongCascadeFn(id);
      } else {
        db.prepare('DELETE FROM songs WHERE id=?').run(id);
      }
      deleted++;
    } catch (e) {
      log.error('AUTO_CLEAN', `删除损坏歌曲失败 id=${id}: ${e.message}`);
      failed++;
    }
  }
  return { deleted, failed };
}

// ---------- 孤儿记录检测（文件不存在） ----------
function findOrphanSongs() {
  const all = db.prepare('SELECT id, title, artist, filepath FROM songs').all();
  const orphans = [];
  for (const s of all) {
    try {
      if (!fs.existsSync(s.filepath)) orphans.push(s);
    } catch (e) { orphans.push(s); }
  }
  return orphans;
}

// ---------- 分离任务历史清理 ----------
function cleanupOldJobs(maxAgeDays = 30) {
  const cutoff = new Date(Date.now() - maxAgeDays * 86400000).toISOString();
  try {
    const r = db.prepare("DELETE FROM separation_jobs WHERE status='failed' AND finished_at < ?").run(cutoff);
    if (r.changes > 0) log.info('AUTO_CLEAN', `已清理 ${r.changes} 条超过 ${maxAgeDays} 天的 failed 分离任务记录`);
    return r.changes;
  } catch (e) {
    log.error('AUTO_CLEAN', `清理旧分离任务失败: ${e.message}`);
    return 0;
  }
}

// ---------- 综合自动清理入口（定时任务调用） ----------
function runAutoCleanup({ deleteSongCascadeFn } = {}) {
  const result = {
    sep: null,
    orphans: [],
    oldJobs: 0,
    damaged: getDamagedCount(),
  };
  try { result.sep = runSepCleanup(); } catch (e) { log.error('AUTO_CLEAN', `separated 清理异常: ${e.message}`); }
  try { result.oldJobs = cleanupOldJobs(30); } catch (e) {}
  // 孤儿记录只检测不自动删除（安全起见，需管理员确认）
  try {
    const orphans = findOrphanSongs();
    result.orphans = orphans.slice(0, 50).map(s => ({ id: s.id, title: s.title, artist: s.artist }));
    result.orphanTotal = orphans.length;
    if (orphans.length > 0) {
      log.warn('AUTO_CLEAN', `检测到 ${orphans.length} 首孤儿歌曲记录(文件不存在)，请管理员在后台确认后处理`);
    }
  } catch (e) {}
  return result;
}

module.exports = {
  // separated 缓存
  getSepSettings, saveSepSettings, runSepCleanup, cleanupSepAll, getSepStats,
  cleanupSepOrphans, cleanupSepBySize, cleanupSepByTime,
  // 损坏文件
  registerProbeFailure, resetProbeFailure, getDamagedSongs, getDamagedCount,
  clearDamageFlag, deleteDamagedSongs, getDamageThreshold, setDamageThreshold,
  // 孤儿记录
  findOrphanSongs,
  // 任务清理
  cleanupOldJobs,
  // 综合入口
  runAutoCleanup,
  SEP_DIR,
};
