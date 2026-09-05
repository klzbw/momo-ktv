// 歌词获取与解析：
//  1) 本地同名 .lrc（最可靠，用户曲库约 15000 首已有同名歌词）——同目录同主名
//  2) 在线三源兜底：网易云 → QQ 音乐 → 酷我，任一成功即返回（个人本地 K 歌使用）
//  3) 统一规范化为标准 LRC 文本([mm:ss.xx]歌词)，并提供解析成逐行时间轴的工具
// 设计原则：在线抓取是网络 IO 且各站反爬策略多变，绝不在 3 万首的扫描循环里
// 同步逐首请求；扫描阶段只读本地 .lrc，在线抓取走"按需/后台批量"接口，限速、
// 单源失败自动降级，不影响点歌与播放主链路。
const fs = require('fs');
const path = require('path');
const log = require('./logger');

const FETCH_TIMEOUT_MS = 8000;

// 带超时的 fetch（Node 20 全局 fetch + AbortController）
async function fetchText(url, { headers = {}, timeout = FETCH_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        ...headers,
      },
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, opts) {
  const txt = await fetchText(url, opts);
  return JSON.parse(txt.replace(/^[\s﻿]+/, ''));
}

// ---------- 文本相似度（用于在线候选匹配，避免抓错歌）----------
function normalize(s) {
  return String(s || '').toLowerCase().replace(/[\s'"\-·.,!?，。！？、（）()【】\[\]]/g, '');
}
function titleSimilarity(a, b) {
  const x = normalize(a), y = normalize(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.9;
  // 简单公共字符重合度
  const setY = new Set(y);
  let hit = 0;
  for (const ch of x) if (setY.has(ch)) hit++;
  return hit / Math.max(x.length, y.length);
}

// ---------- 本地同名 .lrc ----------
// 音频/整轨文件同目录、同主名的 .lrc；CUE 分轨额外尝试 "整轨名-歌名.lrc"
function findLocalLrc(song) {
  const bases = [];
  if (song.filepath) {
    const dir = path.dirname(song.filepath);
    const stem = path.basename(song.filepath, path.extname(song.filepath));
    bases.push(path.join(dir, stem + '.lrc'));
    if (song.media_type === 'cue' && song.title) bases.push(path.join(dir, `${stem}-${song.title}.lrc`));
  }
// 智能读取文本：先 UTF-8，出现乱码替换符则回退 GBK（大量老 LRC 是 GBK 编码）
function readTextSmart(p){
  const buf=fs.readFileSync(p);
  let s=buf.toString('utf8');
  if(s.includes('\uFFFD')){ try{ s=new TextDecoder('gbk').decode(buf); }catch(e){} }
  return s;
}
  for (const p of bases) {
    try { if (fs.existsSync(p)) return readTextSmart(p); } catch (e) { /* 忽略，继续候选 */ }
  }
  return null;
}

// ---------- LRC 规范化与解析 ----------
const LRC_TIME_RE = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
// 去掉空行、把多时间标签行拆开、按时间排序，输出干净的标准 LRC
function normalizeLrc(raw) {
  if (!raw) return '';
  const lines = String(raw).replace(/^﻿/, '').split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    LRC_TIME_RE.lastIndex = 0;
    const tags = [];
    let m;
    while ((m = LRC_TIME_RE.exec(line)) !== null) {
      const min = parseInt(m[1], 10), sec = parseInt(m[2], 10);
      const frac = m[3] ? parseInt((m[3] + '00').slice(0, 2), 10) / 100 : 0;
      tags.push(min * 60 + sec + frac);
    }
    if (!tags.length) continue; // 跳过纯元数据行(ar/ti/al/by/offset)
    const text = line.replace(LRC_TIME_RE, '').trim();
    for (const t of tags) out.push({ t, text });
  }
  out.sort((a, b) => a.t - b.t);
  return out.map(({ t, text }) => {
    const mm = String(Math.floor(t / 60)).padStart(2, '0');
    const ss = String(Math.floor(t % 60)).padStart(2, '0');
    const xx = String(Math.round((t - Math.floor(t)) * 100)).padStart(2, '0');
    return `[${mm}:${ss}.${xx}]${text}`;
  }).join('\n');
}

// 标准 LRC -> 逐行 [{time, text}]，供前端逐行滚动
function parseLrc(lrc) {
  const res = [];
  for (const line of String(lrc || '').split(/\r?\n/)) {
    const m = line.match(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\](.*)$/);
    if (!m) continue;
    const frac = m[3] ? parseInt((m[3] + '00').slice(0, 2), 10) / 100 : 0;
    res.push({ time: parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac, text: (m[4] || '').trim() });
  }
  return res.sort((a, b) => a.time - b.time);
}

// ---------- 在线源 1：网易云 ----------
async function fetchNetease(title, artist) {
  const kw = artist ? `${title} ${artist}` : title;
  const search = await fetchJson(`https://music.163.com/api/search/get?s=${encodeURIComponent(kw)}&type=1&limit=5`, {
    headers: { Referer: 'https://music.163.com/' },
  });
  const songs = (search.result && search.result.songs) || [];
  const hit = pickBest(songs, s => s.name, s => (s.artists || []).map(a => a.name).join(','), title, artist);
  if (!hit) return null;
  const ly = await fetchJson(`https://music.163.com/api/song/lyric?id=${hit.id}&lv=1&kv=1&tv=-1`, {
    headers: { Referer: 'https://music.163.com/' },
  });
  const lrc = ly.lrc && ly.lrc.lyric;
  return lrc ? { lrc, source: 'netease' } : null;
}

// ---------- 在线源 2：QQ 音乐（歌词 base64）----------
async function fetchQQ(title, artist) {
  const kw = artist ? `${title} ${artist}` : title;
  const searchUrl = `https://c.y.qq.com/soso/fcgi-bin/client_search_cgi?w=${encodeURIComponent(kw)}&format=json&n=5&p=1`;
  const sj = await fetchJson(searchUrl, { headers: { Referer: 'https://y.qq.com/' } });
  const list = (((sj.data || {}).song || {}).list) || [];
  const hit = pickBest(list, s => s.songname, s => (s.singer || []).map(x => x.name).join(','), title, artist);
  if (!hit || !hit.songmid) return null;
  const lyricUrl = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${hit.songmid}&format=json&nobase64=0&g_tk=5381`;
  const lj = await fetchJson(lyricUrl, { headers: { Referer: 'https://y.qq.com/' } });
  if (!lj.lyric) return null;
  return { lrc: Buffer.from(lj.lyric, 'base64').toString('utf8'), source: 'qq' };
}

// ---------- 在线源 3：酷我（逐句数组拼回 LRC）----------
async function fetchKuwo(title, artist) {
  const kw = artist ? `${title} ${artist}` : title;
  const searchUrl = `http://www.kuwo.cn/api/www/search/searchMusicBykeyWord?key=${encodeURIComponent(kw)}&pn=1&rn=5&httpsStatus=1`;
  const sj = await fetchJson(searchUrl, { headers: { Referer: 'http://www.kuwo.cn/', csrf: '0', Cookie: 'kw_token=0' } });
  const list = ((sj.data || {}).list) || [];
  const hit = pickBest(list, s => s.name, s => s.artist, title, artist);
  if (!hit || !hit.rid) return null;
  const ij = await fetchJson(`http://www.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${hit.rid}`, {
    headers: { Referer: 'http://www.kuwo.cn/', csrf: '0', Cookie: 'kw_token=0' },
  });
  const lrclist = (ij.data && ij.data.lrclist) || [];
  if (!lrclist.length) return null;
  const lrc = lrclist.map(l => {
    const t = Number(l.time) || 0;
    const mm = String(Math.floor(t / 60)).padStart(2, '0');
    const ss = (t % 60).toFixed(2).padStart(5, '0');
    return `[${mm}:${ss}]${l.lineLyric || ''}`;
  }).join('\n');
  return { lrc, source: 'kuwo' };
}

// 在候选列表里挑标题/歌手最匹配的一首
function pickBest(list, getTitle, getArtist, wantTitle, wantArtist) {
  let best = null, bestScore = -1;
  for (const s of list) {
    const t = getTitle(s) || '';
    const a = getArtist(s) || '';
    let score = titleSimilarity(t, wantTitle);
    if (wantArtist && titleSimilarity(a, wantArtist) > 0.5) score += 0.3;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  // 标题相似度至少 0.5 才采用，宁可不抓也不张冠李戴
  return bestScore >= 0.5 ? best : null;
}

const SOURCES = [
  ['netease', fetchNetease],
  ['qq', fetchQQ],
  ['kuwo', fetchKuwo],
];

// 在线抓取：按顺序尝试三源，成功且能规范化出非空歌词即返回；全部失败返回 null
async function fetchLyricsOnline(title, artist) {
  for (const [name, fn] of SOURCES) {
    try {
      const r = await fn(title, artist);
      if (r && r.lrc) {
        const norm = normalizeLrc(r.lrc);
        if (norm && norm.includes('[')) {
          log.info('LYRICS', `在线歌词命中来源=${name}，${norm.split('\n').length} 行（${title} - ${artist || '未知'}）`);
          return { lrc: norm, source: name };
        }
      }
    } catch (e) {
      log.warn('LYRICS', `在线歌词来源 ${name} 失败（${title}）: ${e.message}`);
    }
  }
  return null;
}

// 给一首歌取歌词：先本地同名 lrc，再（可选）在线。返回 {lrc, source} 或 null
async function resolveLyrics(song, { allowOnline = true } = {}) {
  const local = findLocalLrc(song);
  if (local) {
    const norm = normalizeLrc(local);
    if (norm && norm.includes('[')) return { lrc: norm, source: 'local' };
  }
  if (allowOnline) return fetchLyricsOnline(song.title, song.artist);
  return null;
}

module.exports = {
  findLocalLrc, normalizeLrc, parseLrc, resolveLyrics, fetchLyricsOnline, titleSimilarity,
};
