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

const DATA_DIR = process.env.DATA_DIR || '/data';
const SEP_DIR = path.join(DATA_DIR, 'separated');

// 每首歌的分离产物目录（持久卷 /data/separated/<songId>/）
function ensureSongDir(songId) {
  const d = path.join(SEP_DIR, String(songId));
  fs.mkdirSync(d, { recursive: true });
  return d;
}
// 产物的"相对 /data"路径，存进 songs.vocal_path/accomp_path，HLS 阶段再拼绝对路径
const relVocal = (id) => `separated/${id}/vocals.wav`;
const relAccomp = (id) => `separated/${id}/accompaniment.wav`;
function absUnderData(rel) { return rel ? path.join(DATA_DIR, rel) : null; }

const TYPES = ['separate', 'align'];

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
function claimNext(db, { worker = 'anonymous', type = 'separate' } = {}) {
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
    db.prepare("UPDATE songs SET sep_status='done', vocal_path=?, accomp_path=? WHERE id=?")
      .run(relVocal(job.song_id), relAccomp(job.song_id), job.song_id);
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
  return { separate: byStatus('separate'), align: byStatus('align'), songs };
}

module.exports = {
  SEP_DIR, ensureSongDir, relVocal, relAccomp, absUnderData, TYPES,
  enqueue, claimNext, reportProgress, complete, fail, resetJob, reclaimStale, stats,
};
