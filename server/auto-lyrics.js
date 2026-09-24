// auto-lyrics.js —— 入库歌曲自动生成逐字歌词的编排模块
//
// 职责：
//  1. enqueueMissingAlign(db, {limit})：扫描缺逐字歌词的 audio 歌曲，
//     先 best-effort 补抓在线歌词作为 ref（提高 WhisperX 逐字纠错准确率），
//     再调 separate.enqueue 入队 align 任务，由外部 AI Worker 异步处理。
//  2. afterScanAutoLyrics(db, {limit})：扫描/同步完成后的统一入口，
//     先跑网盘歌词兜底，再调 enqueueMissingAlign。setImmediate 异步执行，不阻塞。
//
// 幂等保证：
//  - separate.enqueue 内部已判断 pending/processing 不重复入队；
//  - 本模块 SQL 只查 align_status NOT IN ('pending','processing','done') 的歌；
//  - 纯音乐（instrumental=1）直接跳过。
//
// 限速：在线补抓每首之间 sleep 300ms，避免四源（网易/QQ/酷我/酷狗）被封。

const lyricsMod = require('./lyrics');
const sepMod = require('./separate');
const cloudLyrics = require('./cloud-lyrics');

// ===== LDDC 逐字歌词搜索服务配置（两级歌词管线）=====
// 两级管线：LDDC 直查优先命中在线逐字歌词库，命中则直接回写 DB 不入队 AI Worker；
// LDDC 失败/未命中时自动降级回原逻辑（补抓 ref + 入队 AI Worker）。
// ENABLE_LDDC 设为 'false' 可整体关闭 LDDC，回退纯 AI Worker 管线。
const ENABLE_LDDC = process.env.ENABLE_LDDC !== 'false'; // 默认开启
const LDDC_URL = process.env.LDDC_URL || 'http://127.0.0.1:8766';
const LDDC_TIMEOUT_MS = 15000;

// 限速 sleep 工具
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// 从增强型 LRC 中剥离逐字标签 <mm:ss.xx>，得到普通逐行 LRC
function stripWordTags(enhancedLrc) {
  if (!enhancedLrc) return '';
  return String(enhancedLrc).replace(/<\d{1,2}:\d{1,2}[.:]\d{1,3}>/g, '');
}

/**
 * 向 LDDC 逐字歌词搜索服务查询逐字歌词（两级管线第一级）。
 *
 * 契约：
 *   POST ${LDDC_URL}/lddc/lyrics
 *   body: {title, artist, duration}（duration 单位秒）
 *   成功: {found:true, lrc, source, score, type}
 *   失败: {found:false, error}
 *   GET  /health: {status:'ok'}
 *
 * 任何失败（网络错误、超时、HTTP 非 2xx、found=false、lrc 为空）都返回 null，
 * 调用方据此自动降级为 AI Worker 入队。绝不抛出异常。
 *
 * @param {object} song 歌曲记录，至少含 id/title/artist/duration
 * @returns {Promise<{lrc:string, source:string, score:number, type:string}|null>}
 */
async function _fetchFromLDDC(song) {
  if (!ENABLE_LDDC) return null;
  let timer = null;
  try {
    const ctrl = new AbortController();
    timer = setTimeout(() => ctrl.abort(), LDDC_TIMEOUT_MS);
    // duration 兼容毫秒/秒：>= 100000 视为毫秒，除以 1000 取整
    let duration = Number(song.duration) || 0;
    if (duration >= 100000) duration = Math.round(duration / 1000);
    const resp = await fetch(LDDC_URL + '/lddc/lyrics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: song.title || '', artist: song.artist || '', duration }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!resp.ok) {
      console.warn('[AutoLyrics] LDDC HTTP ' + resp.status + ', id=' + song.id);
      return null;
    }
    const data = await resp.json();
    if (data && data.found === true && data.lrc && String(data.lrc).trim()) {
      return {
        lrc: String(data.lrc),
        source: data.source || 'unknown',
        score: typeof data.score === 'number' ? data.score : 0,
        type: data.type || 'verbatim'
      };
    }
    return null;
  } catch (e) {
    if (timer) clearTimeout(timer);
    console.warn('[AutoLyrics] LDDC fetch failed, id=' + song.id + ': ' + e.message);
    return null;
  }
}

/**
 * 为缺逐字歌词的 audio 歌曲批量入队 align 任务。
 *
 * 查询条件：
 *   media_type='audio'
 *   AND (lyrics_word IS NULL OR lyrics_word='')
 *   AND align_status NOT IN ('pending','processing','done')
 *   AND (instrumental IS NULL OR instrumental=0)
 * 按 id DESC 取 limit 首。
 *
 * 两级管线：
 *   1. 先尝试 LDDC 直查逐字歌词（_fetchFromLDDC），命中则直接回写
 *      lyrics_word/lyrics/lyrics_source 并置 align_status='done'，不入队 AI Worker；
 *   2. LDDC 未命中/失败时，best-effort 补抓在线歌词作为 ref（调 lyricsMod.resolveLyrics），
 *      有则 UPDATE songs SET lyrics=?, lyrics_source=?。补抓失败不阻塞入队。
 *      再调 sepMod.enqueue(db, {songIds, type:'align'}) 实际入队。
 *
 * @returns {{checked:number, enqueued:number, refFetched:number, skipped:number, lddcHit:number}}
 */
async function enqueueMissingAlign(db, { limit = 100 } = {}) {
  // 查询缺逐字歌词、未在排队/处理/完成中的人声歌曲（含 duration 供 LDDC 查询）
  const rows = db.prepare(
    `SELECT id, title, artist, filepath, media_type, lyrics, duration
     FROM songs
     WHERE media_type='audio'
       AND (lyrics_word IS NULL OR lyrics_word='')
       AND align_status NOT IN ('pending','processing','done')
       AND (instrumental IS NULL OR instrumental=0)
     ORDER BY id DESC
     LIMIT ?`
  ).all(limit);

  let checked = rows.length;
  let refFetched = 0;
  let skipped = 0;
  let lddcHit = 0;
  const songIds = [];

  const updateLyrics = db.prepare('UPDATE songs SET lyrics=?, lyrics_source=? WHERE id=?');
  // LDDC 命中回写：增强型逐字 LRC 同时写入 lyrics_word（逐字）和 lyrics（兼容旧字段）
  const updateLddcLyrics = db.prepare(
    "UPDATE songs SET lyrics_word=?, lyrics=?, lyrics_source=?, align_status='done' WHERE id=?"
  );

  for (const song of rows) {
    try {
      // ===== 两级管线第一级：LDDC 直查优先 =====
      // 命中则直接回写 DB 并 continue，不入队 AI Worker；失败/null 自动降级到下方原逻辑
      if (ENABLE_LDDC) {
        const lddc = await _fetchFromLDDC(song);
        if (lddc) {
          // lyrics_word 存增强型逐字 LRC（含 <mm:ss.xx> 标签），lyrics 存剥离标签后的普通 LRC
          const plainLrc = stripWordTags(lddc.lrc);
          updateLddcLyrics.run(lddc.lrc, plainLrc, 'lddc:' + lddc.source, song.id);
          lddcHit++;
          console.log('[AutoLyrics] LDDC hit: id=' + song.id + ' source=' + lddc.source + ' score=' + lddc.score + ' type=' + lddc.type);
          continue; // 不再补抓 ref、不入队 AI Worker
        }
      }

      // best-effort 补抓在线歌词作为 ref（DB 已有歌词则不重复抓）
      if (!song.lyrics || !String(song.lyrics).trim()) {
        try {
          // 注意：网络歌词抓取已由 lyrics.js 的 ENABLE_WEB_LYRICS 总开关禁用（自动歌词已生效）
          // 此处 resolveLyrics 仍会读取本地同名 .lrc 作为 ref，但不会发起网络请求
          const r = await lyricsMod.resolveLyrics(song, { allowOnline: true });
          if (r && r.lrc) {
            updateLyrics.run(r.lrc, r.source, song.id);
            refFetched++;
            console.log('[AutoLyrics] ref lyrics fetched: id=' + song.id + ' source=' + r.source);
          }
        } catch (e) {
          // 补抓失败不阻塞入队（纯 ASR 也能跑）
          console.warn('[AutoLyrics] ref fetch failed, id=' + song.id + ': ' + e.message);
        }
        // 限速：每首之间 sleep 300ms，避免四源被封
        await sleep(300);
      }
      songIds.push(song.id);
    } catch (e) {
      console.error('[AutoLyrics] song processing error, id=' + song.id + ': ' + e.message);
      skipped++;
    }
  }

  // 实际入队（separate.enqueue 幂等：pending/processing 自动跳过）
  let enqueued = 0;
  if (songIds.length > 0) {
    const result = sepMod.enqueue(db, { songIds, type: 'align' });
    enqueued = (result && result.queued) ? result.queued.length : 0;
  }

  console.log('[AutoLyrics] enqueueMissingAlign done: ' + JSON.stringify({ checked, enqueued, refFetched, skipped, lddcHit }));
  return { checked, enqueued, refFetched, skipped, lddcHit };
}

/**
 * 扫描/同步完成后的统一入口。
 *
 * 先跑网盘歌词兜底（复刻 index.js runCloudLyricsFetch 逻辑：
 * 查 media_type='audio' AND lyrics 为空的歌，逐首 fetchCloudLyrics 回写 DB），
 * 再调 enqueueMissingAlign 入队逐字对齐任务。
 *
 * setImmediate 异步执行，不阻塞调用方（扫描/同步的 HTTP 响应）。
 * 供 index.js 扫描钩子和 netktv-scan.js 同步完成后调用。
 */
function afterScanAutoLyrics(db, { limit = 100 } = {}) {
  setImmediate(() => {
    (async () => {
      try {
        // 第一步：网盘歌词兜底（复刻 runCloudLyricsFetch 逻辑）
        const cloudRows = db.prepare(
          `SELECT id, title, artist, media_type, filepath, cloud_account_id
           FROM songs
           WHERE media_type='audio' AND (lyrics IS NULL OR lyrics='')
           ORDER BY id DESC LIMIT ?`
        ).all(limit);

        if (cloudRows.length > 0) {
          console.log('[AutoLyrics] cloud lyrics fallback: ' + cloudRows.length + ' songs need cloud lyrics');
          const upd = db.prepare('UPDATE songs SET lyrics=?, lyrics_source=? WHERE id=?');
          let fetched = 0;
          for (const song of cloudRows) {
            try {
              const cloud = await cloudLyrics.fetchCloudLyrics(song);
              if (cloud && cloud.lrc) {
                upd.run(cloud.lrc, 'cloud', song.id);
                fetched++;
              }
            } catch (e) {
              console.error('[AutoLyrics] cloud fetch error, id=' + song.id + ': ' + e.message);
            }
          }
          console.log('[AutoLyrics] cloud lyrics fallback done: fetched=' + fetched + ' of ' + cloudRows.length);
        }

        // 第二步：入队缺逐字歌词的 align 任务
        await enqueueMissingAlign(db, { limit });
      } catch (e) {
        console.error('[AutoLyrics] afterScanAutoLyrics error: ' + e.message);
      }
    })();
  });
}

module.exports = { enqueueMissingAlign, afterScanAutoLyrics };
