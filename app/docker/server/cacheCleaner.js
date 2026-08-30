// 「曲库管理 - 清理缓存」：HLS 转码产物（.ts 分片）只是一份可以随时重新生成
// 的播放缓存，不是原始曲库数据，但每首歌一旦转码过就会一直占着磁盘空间，
// 长期不清理会把 NAS 的存储空间越吃越紧。hlsgen.js 里原来只有一套写死在
// 环境变量里的"距转码完成超过 N 天"每日清理，管理员没有入口调整策略，也
// 没法按"缓存总共占了多大空间"来控制。
//
// 这个模块把清理策略变成两种、管理员可切换、可持久化保存（跟随 /data，
// 升级/容器重建不受影响）：
//   1) 按存储空间限额清理：缓存总量超过设定的 MB 数时，按"最早点唱过"的
//      顺序依次清理，直到总量降回限额以内；
//   2) 按点歌时间清理：超过设定天数没有被点唱过的缓存自动清理。
// 两种策略都以"点歌时间"（history 表最近一次播放时间，没有播放记录时
// 退回最近一次进入点歌队列的时间，两者都没有再退回缓存目录本身的 mtime）
// 作为判断依据，而不是"转码完成时间"——一首歌哪怕很久以前转码过，只要最近
// 还有人点唱，就不应该被当成冷门数据优先清理掉。
// 孤儿缓存（对应歌曲已经不在曲库里）清理是安全兜底，跟管理员选择哪种策略
// 无关，每次运行都会做。
const fs = require('fs');
const path = require('path');
const db = require('./db');
const log = require('./logger');
const hls = require('./hlsgen');

const MODE_KEY = 'cache_cleanup_mode';       // 'size' | 'time'
const SIZE_LIMIT_KEY = 'cache_size_limit_mb';
const TIME_DAYS_KEY = 'cache_time_days';

const DEFAULT_MODE = 'time';
const DEFAULT_SIZE_LIMIT_MB = 10240; // 10GB，仅作为管理员从未配置过时的默认建议值
const DEFAULT_TIME_DAYS = Number(process.env.HLS_CACHE_MAX_AGE_DAYS) || 3;

function getSettingRaw(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSettingRaw(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function getSettings() {
  const modeRaw = getSettingRaw(MODE_KEY);
  const sizeRaw = Number(getSettingRaw(SIZE_LIMIT_KEY));
  const timeRaw = Number(getSettingRaw(TIME_DAYS_KEY));
  return {
    mode: (modeRaw === 'size' || modeRaw === 'time') ? modeRaw : DEFAULT_MODE,
    sizeLimitMB: Number.isFinite(sizeRaw) && sizeRaw > 0 ? sizeRaw : DEFAULT_SIZE_LIMIT_MB,
    timeDays: Number.isFinite(timeRaw) && timeRaw > 0 ? timeRaw : DEFAULT_TIME_DAYS,
  };
}

function saveSettings({ mode, sizeLimitMB, timeDays }) {
  if (mode === 'size' || mode === 'time') setSettingRaw(MODE_KEY, mode);
  if (Number.isFinite(sizeLimitMB) && sizeLimitMB > 0) setSettingRaw(SIZE_LIMIT_KEY, sizeLimitMB);
  if (Number.isFinite(timeDays) && timeDays > 0) setSettingRaw(TIME_DAYS_KEY, timeDays);
  return getSettings();
}

// 递归统计一个目录的实际占用大小（字节）。单个文件/子目录读取失败（比如
// 刚好被并发清理掉）只跳过，不让整体统计因为一个坏文件而失败。
function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += dirSize(full);
      else total += fs.statSync(full).size;
    } catch (e) { /* 单个文件读取失败，忽略，不影响其余统计 */ }
  }
  return total;
}

// 一首歌的"点歌时间"，用于决定清理的先后顺序：优先用 history 表里最近一次
// 真正播放过的时间；没有播放记录（比如只在 TV 端预览过，还没人正式点唱）
// 就退回最近一次进入点歌队列的时间；两者都没有（缓存是扫描/后台任务生成
// 但从没被点过）就返回 null，交给调用方用目录 mtime 兜底。
function lastRequestTime(songId) {
  try {
    const h = db.prepare('SELECT MAX(played_at) t FROM history WHERE song_id = ?').get(songId);
    if (h && h.t) return new Date(h.t).getTime();
  } catch (e) { /* history 查询失败，继续尝试下一个来源 */ }
  try {
    const q = db.prepare('SELECT MAX(created_at) t FROM queue WHERE song_id = ?').get(songId);
    if (q && q.t) return new Date(q.t).getTime();
  } catch (e) { /* queue 查询失败，继续兜底 */ }
  return null;
}

// 列出 HLS_DIR 下所有"数字目录名=歌曲id"的缓存目录，附带大小和排序用的
// 点歌时间。跳过正在转码中的目录交给调用方决定（不同策略跳过的时机略有
// 不同，这里只负责列出原始数据）。
function listCacheEntries() {
  const HLS_DIR = hls.HLS_DIR;
  if (!fs.existsSync(HLS_DIR)) return [];
  let dirs;
  try {
    dirs = fs.readdirSync(HLS_DIR, { withFileTypes: true });
  } catch (e) {
    log.error('CACHE_CLEAN', `读取 HLS 缓存目录失败: ${e.message}`);
    return [];
  }
  const entries = [];
  for (const d of dirs) {
    if (!d.isDirectory() || !/^\d+$/.test(d.name)) continue; // 只处理规范产物，其它一律不动
    const id = d.name;
    const full = path.join(HLS_DIR, id);
    let mtime = 0;
    try { mtime = fs.statSync(full).mtimeMs; } catch (e) { /* 目录本身读取失败时用 0，排序上会被当成最早 */ }
    const reqTime = lastRequestTime(Number(id));
    entries.push({
      id,
      dir: full,
      size: dirSize(full),
      time: reqTime != null ? reqTime : mtime,
    });
  }
  return entries;
}

function removeEntry(entry, reason) {
  try {
    fs.rmSync(entry.dir, { recursive: true, force: true });
    hls.forgetBuildState(entry.id);
    log.info('CACHE_CLEAN', `[歌曲 id=${entry.id}] 缓存已清理(约 ${(entry.size / 1048576).toFixed(1)}MB)，原因: ${reason}`);
    return true;
  } catch (e) {
    log.error('CACHE_CLEAN', `[歌曲 id=${entry.id}] 缓存清理失败: ${e.message}`);
    return false;
  }
}

// 孤儿缓存清理：对应歌曲已经不在曲库里的缓存目录，跟管理员选择哪种清理
// 策略无关，每次运行（无论手动/自动）都会顺带做一遍，作为安全兜底。
function cleanupOrphans(getValidSongIds) {
  let validIds;
  try {
    validIds = new Set((getValidSongIds ? getValidSongIds() : []).map(Number));
  } catch (e) {
    log.warn('CACHE_CLEAN', `获取有效曲目 id 列表失败，本次跳过孤儿缓存清理: ${e.message}`);
    return { removed: 0, freed: 0 };
  }
  const entries = listCacheEntries().filter(e => !hls.isBuilding(e.id));
  let removed = 0, freed = 0;
  for (const e of entries) {
    if (!validIds.has(Number(e.id))) {
      if (removeEntry(e, '对应歌曲已不在曲库中(孤儿缓存)')) { removed++; freed += e.size; }
    }
  }
  return { removed, freed };
}

// 按存储空间限额清理：总量超过 limitMB 时，按"点歌时间"从早到晚排序，
// 优先清理最早点唱过（或从未被点唱过）的缓存，直到总量回落到限额以内。
function cleanupBySize(limitMB) {
  const limitBytes = limitMB * 1024 * 1024;
  const entries = listCacheEntries().filter(e => !hls.isBuilding(e.id));
  entries.sort((a, b) => a.time - b.time);
  const totalBefore = entries.reduce((s, e) => s + e.size, 0);
  let total = totalBefore;
  let removed = 0, freed = 0;
  for (const e of entries) {
    if (total <= limitBytes) break;
    if (removeEntry(e, `缓存总量(约${(totalBefore / 1048576).toFixed(0)}MB)超出限额 ${limitMB}MB，清理最早点唱过的缓存`)) {
      total -= e.size; freed += e.size; removed++;
    }
  }
  return { removed, freed, totalBefore, totalAfter: total };
}

// 按点歌时间清理：超过 days 天没有被点唱过（或从未被点唱过、缓存目录本身
// 也超过这个天数）的缓存自动清理。
function cleanupByTime(days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const entries = listCacheEntries().filter(e => !hls.isBuilding(e.id));
  let removed = 0, freed = 0;
  for (const e of entries) {
    if (e.time < cutoff) {
      if (removeEntry(e, `距上次点唱已超过 ${days} 天`)) { removed++; freed += e.size; }
    }
  }
  return { removed, freed };
}

// 管理员点击「立即清理」按钮、或后台定时任务，都走这一个入口：先做孤儿
// 缓存兜底清理，再按当前保存的策略（存储空间限额 / 点歌时间）清理一遍。
function runCleanup(getValidSongIds) {
  const orphan = cleanupOrphans(getValidSongIds);
  const settings = getSettings();
  const modeResult = settings.mode === 'size'
    ? cleanupBySize(settings.sizeLimitMB)
    : cleanupByTime(settings.timeDays);
  return { mode: settings.mode, orphan, ...modeResult };
}

// 需求(清理缓存菜单-直接清理全部缓存)：跟按存储空间限额/按点歌时间清理是
// 两回事——那两种策略都是"留一部分、清掉旧的/超额的"，这里是管理员明确要
// "不管三七二十一，现在就把 HLS 转码缓存全部清空"（比如整个曲库改了扫描
// 规则要重新生成、或者单纯想收回一大块磁盘空间），不看点歌时间/大小限额，
// 只跳过正在转码中的目录（避免把正在写入的半成品当成已完成产物误删，也
// 避免把用户正在观看的这首歌缓存删掉导致播放中断）。
function cleanupAll() {
  const entries = listCacheEntries().filter(e => !hls.isBuilding(e.id));
  const skippedBuilding = listCacheEntries().length - entries.length;
  let removed = 0, freed = 0;
  for (const e of entries) {
    if (removeEntry(e, '管理员手动清理全部缓存')) { removed++; freed += e.size; }
  }
  return { removed, freed, skippedBuilding };
}

function getStats() {
  const entries = listCacheEntries();
  const totalSize = entries.reduce((s, e) => s + e.size, 0);
  return { count: entries.length, totalSize, ...getSettings() };
}

module.exports = { getSettings, saveSettings, runCleanup, cleanupAll, getStats, cleanupBySize, cleanupByTime, cleanupOrphans };
