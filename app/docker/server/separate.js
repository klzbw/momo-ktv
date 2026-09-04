// separate.js —— AI 人声分离 / 逐字歌词对齐 的任务队列（服务端纯逻辑，不碰 HTTP）
//
// 分工：真正吃 GPU 的 Demucs(人声分离) 与 WhisperX(逐字对齐) 跑在独立的 Windows
// 工作站(worker，见 P3)；服务端只负责任务的"入队 / 领取 / 进度 / 回收产物 / 状态
// 看板"。worker 通过 HTTP 轮询领取任务、下载源音频、回传 wav 与逐字歌词。
//
// 任务状态机： pending(排队) --claim--> processing(处理中) --complete--> done
//                                                  \--fail--> failed(可重试)
// worker 崩溃留下的 processing 僵尸任务由 reclaimStale() 超时回收为 pending。
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || '/data';
const SEP_DIR = path.join(DATA_DIR, 'separated');

// 分离产物的稳定目录名：源文件路径的 SHA256 前16位。
// 用 filepath 而不是 song.id，因为重新入库后自增 id 会变，但源文件路径不变——
// 这样即使清空重入库，只要源文件没改名，分离产物就能被直接复用，不触发 Demucs 重分离。
function sepKey(filepath) {
  return crypto.createHash('sha256').update(String(filepath || '')).digest('hex').slice(0, 16);
}
// 从数据库查一首歌的 filepath，算 sepKey
function sepKeyForSong(db, songId) {
  const row = db.prepare('SELECT filepath FROM songs WHERE id=?').get(songId);
  return row ? sepKey(row.filepath) : null;
}
// 按 sepKey 创建/获取分离产物目录
function ensureSepDir(key) {
  const d = path.join(SEP_DIR, String(key));
  fs.mkdirSync(d, { recursive: true });
  return d;
}
// 检查某 filepath 的分离产物是否已存在且非空，存在则返回相对路径对，否则 null。
// 支持两种命名格式：
//   新格式：歌手-歌名-人声.flac / 歌手-歌名-伴奏.flac（2026-09-04 起）
//   旧格式：vocals.flac / accompaniment.flac（历史存量）
// 一步到 FLAC 后优先认 .flac；存量 .wav 也照样认（不重复分离），两条轨各自挑可用的扩展名。
function pickExistingTrack(dir, stem) {
  const newSuffix = stem === 'vocals' ? '-人声.' : '-伴奏.';
  try {
    const files = fs.readdirSync(dir);
    for (const ext of ['flac', 'wav']) {
      const match = files.find(f => f.includes(newSuffix) && f.endsWith('.' + ext));
      if (match) {
        const p = path.join(dir, match);
        if (fs.existsSync(p) && fs.statSync(p).size > 1024) return { ext, filename: match };
      }
    }
  } catch (e) { /* 目录不存在，fall through 到旧格式 */ }
  for (const ext of ['flac', 'wav']) {
    const p = path.join(dir, `${stem}.${ext}`);
    try {
      if (fs.existsSync(p) && fs.statSync(p).size > 1024) return { ext, filename: `${stem}.${ext}` };
    } catch (e) { /* 试下一个扩展名 */ }
  }
  return null;
}
function lookupExisting(filepath) {
  const key = sepKey(filepath);
  const dir = path.join(SEP_DIR, key);
  const v = pickExistingTrack(dir, 'vocals');
  const a = pickExistingTrack(dir, 'accompaniment');
  if (v && a) {
    return {
      sep_key: key,
      vocal_path: `separated/${key}/${v.filename}`,
      accomp_path: `separated/${key}/${a.filename}`,
    };
  }
  return null;
}
// 产物的"相对 /data"路径，存进 songs.vocal_path/accomp_path；默认 flac（一步到位）
const relVocal = (key, ext = 'flac') => `separated/${key}/vocals.${ext}`;
const relAccomp = (key, ext = 'flac') => `separated/${key}/accompaniment.${ext}`;
function absUnderData(rel) { return rel ? path.join(DATA_DIR, rel) : null; }

const TYPES = ['separate', 'align'];

// ==================== 双模调度：GPU 优先、CPU 兜底 ====================
// 一个服务端可同时挂多个 worker：飞牛本地 N 卡容器、外置 PC 显卡工作站、飞牛本地
// CPU 容器。worker 每 3 秒轮询一次 claim/progress，据此维护"在线表"（纯内存，重启
// 即重建）。调度策略：只要有 GPU worker 在线，新任务先给 GPU（快）；任务排队超过
// GPU_RESERVE_MS 还没被 GPU 领走（说明没有空闲 GPU），CPU worker 才兜底，避免任务
// 被慢 CPU 抢占、也不会在 GPU 离线时永远卡住。
const WORKERS = new Map();                       // name -> {capability, lastSeen(ms)}
const ONLINE_TTL_MS = 30 * 1000;                 // 30 秒没心跳判离线（长任务靠 progress 续命）
const GPU_RESERVE_MS = 45 * 1000;                // CPU 兜底前给 GPU 的预留窗口

function touchWorker(worker, capability) {
  const name = String(worker || 'anonymous').slice(0, 64);
  WORKERS.set(name, { capability: capability === 'gpu' ? 'gpu' : 'cpu', lastSeen: Date.now() });
}
function onlineWorkers() {
  const now = Date.now(), list = [];
  for (const [name, w] of WORKERS) {
    if (now - w.lastSeen <= ONLINE_TTL_MS) list.push({ name, capability: w.capability, idleSec: Math.round((now - w.lastSeen) / 1000) });
  }
  return list;
}
function hasOnlineGpu(exceptWorker) {
  return onlineWorkers().some(w => w.capability === 'gpu' && w.name !== exceptWorker);
}
// SQLite CURRENT_TIMESTAMP 是 UTC 文本 'YYYY-MM-DD HH:MM:SS'，转成已等待毫秒
function jobAgeMs(createdAt) {
  if (!createdAt) return 0;
  const t = Date.parse(String(createdAt).replace(' ', 'T') + 'Z');
  return Number.isFinite(t) ? Date.now() - t : 0;
}


// 判断一份歌词能否作为"逐字纠错参考"：去掉时间标签后要有足够比例的中文/字母数字。
// 乱码（GBK 被按 Latin1 误解码，形如 æµ·åº）CJK 占比极低，直接判不可用，避免反而带偏纠错。
function isUsableRefLyrics(lrc) {
  if (!lrc || lrc.length < 4) return false;
  const body = String(lrc).replace(/\[[^\]]*\]/g, '').replace(/<[^>]*>/g, '');
  const chars = [...body.replace(/\s/g, '')];
  if (chars.length < 4) return false;
  let good = 0;
  for (const ch of chars) {
    const code = ch.codePointAt(0);
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x30 && code <= 0x39) ||
        (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) good++;
  }
  return good / chars.length > 0.3;
}

// 入队。type: 'separate' | 'align' | 'both'。force=true 时连已完成的也重新排队。
// 返回 {added, skipped, queued:[songId...]}；幂等：pending/processing 不重复入队，
// failed 自动重置重试，done 仅在 force 时重排。
function enqueue(db, { songIds = [], type = 'separate', force = false } = {}) {
  const types = type === 'both' ? TYPES : (TYPES.includes(type) ? [type] : ['separate']);
  const findJob = db.prepare('SELECT * FROM separation_jobs WHERE song_id=? AND job_type=?');
  const insert = db.prepare("INSERT INTO separation_jobs (song_id, job_type, status) VALUES (?,?,'pending')");
  const reset = db.prepare("UPDATE separation_jobs SET status='pending', error=NULL, progress=0 WHERE id=?");
  let added = 0, skipped = 0; const queued = [];
  const tx = db.transaction((ids) => {
    for (const rawId of ids) {
      const songId = parseInt(rawId, 10);
      if (!Number.isInteger(songId)) continue;
      const song = db.prepare('SELECT id FROM songs WHERE id=?').get(songId);
      if (!song) { skipped++; continue; }
      for (const t of types) {
        const exist = findJob.get(songId, t);
        if (!exist) { insert.run(songId, t); added++; queued.push(songId); }
        else if (exist.status === 'failed') { reset.run(exist.id); added++; queued.push(songId); }
        else if (exist.status === 'done' && force) { reset.run(exist.id); added++; queued.push(songId); }
        else skipped++;
      }
      // 歌曲主状态同步为"排队中"
      if (types.includes('separate')) db.prepare("UPDATE songs SET sep_status='pending' WHERE id=? AND sep_status!='done'").run(songId);
      if (types.includes('align')) db.prepare("UPDATE songs SET align_status='pending' WHERE id=? AND align_status!='done'").run(songId);
    }
  });
  tx(songIds);
  return { added, skipped, queued: [...new Set(queued)] };
}

// worker 领取一个任务（事务 + 条件更新，多 worker 并发也不会领到同一个）
function claimNext(db, { worker = 'anonymous', type = 'separate', capability = 'cpu' } = {}) {
  touchWorker(worker, capability);
  // CPU worker 来领任务时：若有别的 GPU worker 在线、且队头任务仍在 GPU 预留窗口内，
  // 本轮先让 CPU 空转（返回 null -> 路由回 204），把任务留给更快的 GPU。
  if (capability !== 'gpu') {
    const head = db.prepare(
      "SELECT created_at FROM separation_jobs WHERE status='pending' AND job_type=? ORDER BY id LIMIT 1"
    ).get(type);
    if (head && hasOnlineGpu(worker) && jobAgeMs(head.created_at) < GPU_RESERVE_MS) return null;
  }
  const tx = db.transaction(() => {
    const job = db.prepare("SELECT * FROM separation_jobs WHERE status='pending' AND job_type=? ORDER BY id LIMIT 1").get(type);
    if (!job) return null;
    const r = db.prepare(
      "UPDATE separation_jobs SET status='processing', worker=?, claimed_at=CURRENT_TIMESTAMP, attempts=attempts+1 WHERE id=? AND status='pending'"
    ).run(worker, job.id);
    if (r.changes === 0) return null; // 被别的 worker 抢先
    return db.prepare('SELECT * FROM separation_jobs WHERE id=?').get(job.id);
  });
  const job = tx();
  if (!job) return null;
  const song = db.prepare('SELECT * FROM songs WHERE id=?').get(job.song_id);
  if (!song) { fail(db, job.id, '对应歌曲已不存在'); return null; }
  // 歌曲主状态 -> processing
  const col = job.job_type === 'align' ? 'align_status' : 'sep_status';
  db.prepare(`UPDATE songs SET ${col}='processing' WHERE id=?`).run(song.id);
  return {
    job: { id: job.id, songId: job.song_id, type: job.job_type, attempts: job.attempts },
    song: {
      id: song.id, title: song.title, artist: song.artist, mediaType: song.media_type,
      duration: song.duration, cueTrack: song.cue_track, startOffset: song.start_offset, endOffset: song.end_offset,
      hasLocalLyrics: !!(song.lyrics && song.lyrics.length),
      // 对齐任务把"官方正确歌词文本"带给 worker，用于逐字纠错（文字以官方为准、时间用WhisperX）；
      // 分离任务用不到，且乱码歌词不下发（isUsableRefLyrics 过滤）
      refLyrics: job.job_type === 'align' && isUsableRefLyrics(song.lyrics) ? song.lyrics : null,
    },
    // worker 用这个地址下载待处理音频（CUE 分轨服务端会自动截取对应区间）
    sourceUrl: `/api/songs/${song.id}/source`,
  };
}

function reportProgress(db, jobId, progress) {
  const p = Math.max(0, Math.min(100, parseInt(progress, 10) || 0));
  db.prepare('UPDATE separation_jobs SET progress=? WHERE id=?').run(p, jobId);
}

// 任务完成。separate: 产物已由上传路由落盘，这里只登记相对路径；align: lyricsWord 逐字歌词
function complete(db, jobId, { lyricsWord = null, result = null } = {}) {
  const job = db.prepare('SELECT * FROM separation_jobs WHERE id=?').get(jobId);
  if (!job) throw new Error('job not found');
  const resultJson = JSON.stringify(result || {});
  db.prepare("UPDATE separation_jobs SET status='done', progress=100, error=NULL, result_json=?, finished_at=CURRENT_TIMESTAMP WHERE id=?").run(resultJson, jobId);
  if (job.job_type === 'separate') {
    // 用源文件路径的 SHA256 作为分离产物目录名，而非 song.id——
    // 这样重新入库后 id 变了也能直接复用已有分离产物，不触发重分离。
    const key = sepKeyForSong(db, job.song_id) || String(job.song_id);
    // 实际落盘成 flac 还是回退的 wav，由 complete 路由写进 result.saved 的键名决定：
    // 只有"存在 wav 且不存在 flac"时才登记 wav，其余一律登记 flac。
    const saved = (result && result.saved) || {};
    const vExt = (saved['vocals.wav'] && !saved['vocals.flac']) ? 'wav' : 'flac';
    const aExt = (saved['accompaniment.wav'] && !saved['accompaniment.flac']) ? 'wav' : 'flac';
    // 新命名格式：歌手-歌名-人声.flac / 歌手-歌名-伴奏.flac
    const songRow = db.prepare('SELECT title, artist FROM songs WHERE id=?').get(job.song_id);
    const sanitize = (s) => String(s || '未知').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
    const baseName = sanitize(songRow ? songRow.artist : '未知') + '-' + sanitize(songRow ? songRow.title : '未知');
    const vFilename = baseName + '-人声.' + vExt;
    const aFilename = baseName + '-伴奏.' + aExt;
    // 重命名已落盘的文件（complete 路由先存为 vocals.flac/accompaniment.flac，这里改成新命名）
    const sepDir = path.join(SEP_DIR, key);
    try {
      const oldV = path.join(sepDir, 'vocals.' + vExt);
      const newV = path.join(sepDir, vFilename);
      if (fs.existsSync(oldV) && oldV !== newV) fs.renameSync(oldV, newV);
      const oldA = path.join(sepDir, 'accompaniment.' + aExt);
      const newA = path.join(sepDir, aFilename);
      if (fs.existsSync(oldA) && oldA !== newA) fs.renameSync(oldA, newA);
    } catch (e) { console.error('重命名分离产物失败:', e.message); }
    db.prepare("UPDATE songs SET sep_status='done', vocal_path=?, accomp_path=? WHERE id=?")
      .run(`separated/${key}/${vFilename}`, `separated/${key}/${aFilename}`, job.song_id);
  } else {
    db.prepare("UPDATE songs SET align_status='done', lyrics_word=COALESCE(?,lyrics_word) WHERE id=?").run(lyricsWord, job.song_id);
  }
  return db.prepare('SELECT * FROM separation_jobs WHERE id=?').get(jobId);
}

function fail(db, jobId, error) {
  const job = db.prepare('SELECT * FROM separation_jobs WHERE id=?').get(jobId);
  if (!job) return;
  db.prepare("UPDATE separation_jobs SET status='failed', error=?, finished_at=CURRENT_TIMESTAMP WHERE id=?").run(String(error || 'unknown').slice(0, 1000), jobId);
  const col = job.job_type === 'align' ? 'align_status' : 'sep_status';
  db.prepare(`UPDATE songs SET ${col}='failed' WHERE id=?`).run(job.song_id);
}

function resetJob(db, jobId) {
  db.prepare("UPDATE separation_jobs SET status='pending', progress=0, error=NULL, worker=NULL, claimed_at=NULL WHERE id=?").run(jobId);
}

// worker 异常退出留下的 processing 僵尸任务，超过 staleMin 分钟回收为 pending（attempts 已自增）
function reclaimStale(db, staleMin = 20) {
  const rows = db.prepare(
    "SELECT id FROM separation_jobs WHERE status='processing' AND claimed_at IS NOT NULL AND (julianday(CURRENT_TIMESTAMP)-julianday(claimed_at))*24*60 > ?"
  ).all(staleMin);
  const upd = db.prepare("UPDATE separation_jobs SET status='pending', worker=NULL WHERE id=?");
  const tx = db.transaction((list) => list.forEach((r) => upd.run(r.id)));
  tx(rows);
  return rows.length;
}

function stats(db) {
  const byStatus = (t) => db.prepare(
    'SELECT status, COUNT(*) c FROM separation_jobs WHERE job_type=? GROUP BY status'
  ).all(t).reduce((m, r) => { m[r.status] = r.c; return m; }, {});
  const songs = {
    separated: db.prepare("SELECT COUNT(*) c FROM songs WHERE sep_status='done'").get().c,
    aligned: db.prepare("SELECT COUNT(*) c FROM songs WHERE align_status='done'").get().c,
    audioTotal: db.prepare("SELECT COUNT(*) c FROM songs WHERE media_type IN ('audio','cue')").get().c,
  };
  return { separate: byStatus('separate'), align: byStatus('align'), songs, workers: onlineWorkers() };
}

module.exports = {
  SEP_DIR, sepKey, sepKeyForSong, ensureSepDir, lookupExisting, relVocal, relAccomp, absUnderData, TYPES,
  enqueue, claimNext, reportProgress, complete, fail, resetJob, reclaimStale, stats,
  touchWorker, onlineWorkers,
};
