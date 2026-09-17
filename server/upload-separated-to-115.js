#!/usr/bin/env node
/**
 * upload-separated-to-115.js —— 分离产物上传 115 + 生成 STRM 指针 + 回写数据库 + 磁盘清理
 *
 * 运行环境：momo-ktv 容器内（node，工作目录 /app）。
 *
 * 做什么：
 *   1. 扫描 /data/separated/<16位hash>/ 下所有人声/伴奏 FLAC。
 *   2. 通过 Alist API（容器内 http://127.0.0.1:5345）检查 115 上
 *      /云盘/pan115/我的115/momo-ktv/separated/<hash>/ 是否已有同名文件；
 *      缺失则 mkdir + PUT /api/fs/put 上传（File-Path 头按段 URL 编码）。
 *   3. 在 /data/netseparated-strm/ 生成 <hash>_vocals.strm / <hash>_accomp.strm，
 *      内容为 Alist /d/ 直链（不带认证）。已存在且内容一致则跳过。
 *   4. 回写 SQLite：把所有属于该 hash 的歌曲的 vocal_path / accomp_path
 *      指向上面两个 .strm 绝对路径。
 *
 * 磁盘清理（高风险，需显式开启）：
 *   --cleanup
 *      仅在【上传115 + strm生成 + DB回写】全部成功后，对该 hash 做前置门控：
 *        该 hash 对应的【所有】歌曲必须满足
 *          sep_status='done' AND (align_status='done' OR 纯音乐/无人声)
 *      门控通过后，删除 /data/separated/<hash>/ 下的人声/伴奏 FLAC 文件（保留空目录）。
 *      门控不通过 -> [SKIP-CLEANUP] 并记录原因。
 *   --delete-source（必须配合 --cleanup）
 *      清理本地 FLAC 后，按歌曲 filepath 删除【非 FLAC】音频源文件
 *      （.wav/.ape/.wv/.tta/.dts/.mp3/.m4a/.aac/.opus 等）。
 *      CUE 多首歌共享同一 filepath（如 CDImage.ape）：必须该 filepath 下所有歌曲
 *      都通过上面的门控才删，否则跳过。FLAC 源(.flac)和视频(.mkv等)不删。
 *
 * 守护进程：
 *   --daemon   每 60 秒扫描一次新增分离目录（增量），已处理 hash 记入
 *              /data/upload-115-state.json，重启不重复处理。
 *              首次启动时把当前已存在的目录全部标记为"已见"（不处理、不清理），
 *              从而保证存量 2707 个分离产物的本地 FLAC 不被误删。
 *              支持 SIGTERM 优雅退出。
 *
 * 幂等：重复运行不会重复上传、不会重复写 strm、数据库只在值变化时更新。
 *
 * 命令行：
 *   node upload-separated-to-115.js [--full] [--since <ts>] [--dry-run] [--limit N]
 *                                   [--cleanup] [--delete-source] [--daemon]
 *     --full          处理所有目录（默认即全量）
 *     --since <ts>    只处理 mtime >= ts 的目录（unix秒或ISO时间）
 *     --dry-run       只打印计划，实际上传/写文件/删文件/写库都不执行
 *     --limit N       只处理前 N 个目录
 *     --cleanup       清理本地 FLAC（见上）
 *     --delete-source 配合 --cleanup，删除非 FLAC 源文件
 *     --daemon        守护进程模式（60秒轮询增量）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

// ============ 配置（可用环境变量覆盖） ============
const ALIST_API = process.env.ALIST_API || 'http://127.0.0.1:5345';   // 容器内 Alist
const ALIST_USER = process.env.ALIST_USER || 'admin';
const ALIST_PASS = process.env.ALIST_PASS || 'admin123';
const ALIST_PUBLIC = process.env.ALIST_PUBLIC_BASE || 'http://192.168.3.16:5345';
const REMOTE_ROOT = process.env.REMOTE_ROOT || '/云盘/pan115/我的115/momo-ktv/separated';

const DATA_DIR = process.env.DATA_DIR || '/data';
const SEP_DIR = path.join(DATA_DIR, 'separated');
const STRM_DIR = path.join(DATA_DIR, 'netseparated-strm');
const DB_PATH = path.join(DATA_DIR, 'ktv.db');
const STATE_FILE = path.join(DATA_DIR, 'upload-115-state.json');
const DAEMON_INTERVAL_MS = 60 * 1000;

// 删除源文件允许的扩展名（非 FLAC 音频）。.flac 明确不删，视频(.mkv/.mp4等)不删。
const DELETABLE_SRC_EXT = new Set(['.wav', '.ape', '.wv', '.tta', '.dts', '.mp3', '.m4a', '.aac', '.opus']);

// 纯音乐/无人声关键词（保守匹配，宁可误判为"非纯音乐"从而跳过清理，也不要误删有 vocal 的）
const INSTRUMENTAL_RE = /(纯音乐|轻音乐|纯伴奏|无演唱|无人声|器乐|独奏曲|交响曲|管弦乐|进行曲|钢琴曲|古筝|二胡|琵琶|笛子|萨克斯|小提琴|大提琴|手风琴|葫芦丝|instrumental|no vocal|karaoke)/i;

// ============ 命令行参数 ============
const argv = process.argv.slice(2);
const opts = {
  full: false, since: null, sinceMs: null, dryRun: false,
  limit: Infinity, cleanup: false, deleteSource: false, daemon: false,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--full') opts.full = true;
  else if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--cleanup') opts.cleanup = true;
  else if (a === '--delete-source') opts.deleteSource = true;
  else if (a === '--daemon') opts.daemon = true;
  else if (a === '--since') { opts.since = argv[++i]; }
  else if (a === '--limit') { opts.limit = parseInt(argv[++i], 10) || Infinity; }
  else { console.error('未知参数:', a); process.exit(2); }
}
if (opts.deleteSource && !opts.cleanup) {
  console.error('--delete-source 必须配合 --cleanup 使用'); process.exit(2);
}
if (opts.since !== null) {
  const t = Number(opts.since);
  opts.sinceMs = Number.isFinite(t) && String(t).length <= 11 ? t * 1000 : Date.parse(opts.since);
  if (!Number.isFinite(opts.sinceMs)) { console.error('--since 无法解析:', opts.since); process.exit(2); }
}

const LOG_FILE = opts.daemon
  ? path.join(DATA_DIR, 'upload-115-daemon.log')
  : path.join(DATA_DIR, 'upload-115.log');

// ============ 日志 ============
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) { /* 忽略 */ }
}

// ============ Alist HTTP 封装 ============
function alistRequest(method, urlPath, { headers = {}, body = null, raw = false, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(ALIST_API + urlPath);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method, headers, timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (raw) return resolve({ status: res.statusCode, headers: res.headers, body: buf });
        const text = buf.toString('utf-8');
        try { resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(text) }); }
        catch (e) { resolve({ status: res.statusCode, headers: res.headers, text }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (body) {
      if (Buffer.isBuffer(body)) req.end(body);
      else if (typeof body.pipe === 'function') body.pipe(req);
      else req.end(body);
    } else {
      req.end();
    }
  });
}

async function alistLogin() {
  const { json } = await alistRequest('POST', '/api/auth/login', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ALIST_USER, password: ALIST_PASS }),
  });
  if (!json || json.code !== 200) throw new Error('Alist 登录失败: ' + JSON.stringify(json));
  return json.data.token;
}

async function alistJson(token, method, urlPath, bodyObj, { timeout = 120000 } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { json } = await alistRequest(method, urlPath, {
        headers: { 'Authorization': token, 'Content-Type': 'application/json' },
        body: bodyObj ? JSON.stringify(bodyObj) : null,
        timeout,
      });
      return json;
    } catch (e) {
      lastErr = e;
      log(`  [重试 ${attempt}/3] ${method} ${urlPath}: ${e.message}`);
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastErr;
}

function encodeAlistPath(p) {
  return p.split('/').map((seg, i) => (i === 0 ? '' : encodeURIComponent(seg))).join('/');
}

async function listRemoteDirNames(token, root) {
  const names = new Set();
  let page = 1;
  while (true) {
    const json = await alistJson(token, 'POST', '/api/fs/list', {
      path: root, password: '', page, per_page: 500, refresh: false,
    });
    if (json.code !== 200) break;
    const content = (json.data && json.data.content) || [];
    for (const e of content) if (e.is_dir) names.add(e.name);
    const total = (json.data && json.data.total) || 0;
    if (names.size >= total || content.length === 0) break;
    page++;
    if (page > 20) break;
  }
  return names;
}

async function listRemote(token, remoteDir) {
  const json = await alistJson(token, 'POST', '/api/fs/list', {
    path: remoteDir, password: '', page: 1, per_page: 200, refresh: false,
  });
  if (json.code !== 200) return null;
  const content = (json.data && json.data.content) || [];
  const set = new Set();
  for (const e of content) if (!e.is_dir) set.add(e.name);
  return set;
}

async function mkdirRemote(token, remoteDir) {
  const json = await alistJson(token, 'POST', '/api/fs/mkdir', { path: remoteDir });
  if (json.code !== 200) throw new Error('mkdir 失败 ' + remoteDir + ': ' + JSON.stringify(json));
}

async function uploadOne(token, localPath, remoteFullPath) {
  const size = fs.statSync(localPath).size;
  const encoded = encodeAlistPath(remoteFullPath);
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { status, json, text } = await new Promise((resolve, reject) => {
        const u = new URL(ALIST_API + '/api/fs/put');
        const headers = {
          'Authorization': token,
          'File-Path': encoded,
          'Content-Length': String(size),
          'Content-Type': 'application/octet-stream',
        };
        const req = http.request({
          hostname: u.hostname, port: u.port, path: '/api/fs/put',
          method: 'PUT', headers, timeout: 600000,
        }, (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            const t = buf.toString('utf-8');
            try { resolve({ status: res.statusCode, json: JSON.parse(t), text: t }); }
            catch (e) { resolve({ status: res.statusCode, json: null, text: t }); }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('upload timeout')); });
        fs.createReadStream(localPath).pipe(req);
      });
      if (status === 200 || status === 204) {
        if (json && json.code && json.code !== 200) {
          throw new Error('put 返回 code=' + json.code + ' ' + JSON.stringify(json.message || json));
        }
        return;
      }
      throw new Error('put HTTP ' + status + ' ' + (text || '').slice(0, 200));
    } catch (e) {
      lastErr = e;
      log(`  [上传重试 ${attempt}/3] ${path.basename(localPath)}: ${e.message}`);
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr;
}

// ============ 本地分离产物识别 ============
function pickTrack(dir, kind) {
  const keyword = kind === 'vocals' ? '人声' : '伴奏';
  let files;
  try { files = fs.readdirSync(dir); } catch (e) { return null; }
  for (const ext of ['flac', 'wav']) {
    const cn = files.find(f => f.toLowerCase().endsWith('.' + ext) && f.includes('-' + keyword + '.'));
    if (cn) {
      const p = path.join(dir, cn);
      try { if (fs.statSync(p).size > 1024) return { filename: cn, ext }; } catch (e) {}
    }
  }
  const legacy = kind === 'vocals' ? 'vocals' : 'accompaniment';
  for (const ext of ['flac', 'wav']) {
    const p = path.join(dir, `${legacy}.${ext}`);
    try { if (fs.existsSync(p) && fs.statSync(p).size > 1024) return { filename: `${legacy}.${ext}`, ext }; } catch (e) {}
  }
  return null;
}

// ============ STRM ============
function strmUrl(hash, filename) {
  const segs = REMOTE_ROOT.split('/').concat([hash, filename]);
  const enc = segs.map((s, i) => (i === 0 ? '' : encodeURIComponent(s))).join('/');
  return `${ALIST_PUBLIC}/d${enc}`;
}

function writeStrmIfNeeded(hash, kind, filename, stats) {
  const name = `${hash}_${kind}.strm`;
  const filePath = path.join(STRM_DIR, name);
  const expected = strmUrl(hash, filename);
  if (fs.existsSync(filePath)) {
    let cur = '';
    try { cur = fs.readFileSync(filePath, 'utf-8').trim(); } catch (e) {}
    if (cur === expected) { stats.strmSkipped++; return filePath; }
    if (!opts.dryRun) fs.writeFileSync(filePath, expected);
    stats.strmWritten++;
    return filePath;
  }
  if (!opts.dryRun) fs.writeFileSync(filePath, expected);
  stats.strmWritten++;
  return filePath;
}

// ============ 数据库 ============
function loadDb() {
  const Database = require('better-sqlite3');
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  return db;
}

// 构建 hash -> [songRow...] 映射。
// songRow: { id, filepath, vocal_path, align_status, title, artist, album }
function buildHashMap(db) {
  const rows = db.prepare(
    "SELECT id, filepath, vocal_path, align_status, title, artist, IFNULL(album,'') AS album FROM songs WHERE sep_status='done'"
  ).all();
  const map = new Map();
  for (const r of rows) {
    const vp = r.vocal_path || '';
    let m = vp.match(/separated\/([0-9a-f]{16})\//);
    if (!m) m = vp.match(/netseparated-strm\/([0-9a-f]{16})_/);
    let hash = m ? m[1] : null;
    if (!hash) {
      hash = crypto.createHash('sha256').update(String(r.filepath || '')).digest('hex').slice(0, 16);
    }
    if (!map.has(hash)) map.set(hash, []);
    map.get(hash).push(r);
  }
  return map;
}

function updateDbForHash(db, hash, map, vocalStrm, accompStrm, stats) {
  const rows = map.get(hash);
  if (!rows || !rows.length) { stats.dbNoSong++; return 0; }
  const ids = rows.map(r => r.id);
  const upd = db.prepare(
    "UPDATE songs SET vocal_path=?, accomp_path=? WHERE id=? AND (IFNULL(vocal_path,'')!=? OR IFNULL(accomp_path,'')!=?)"
  );
  const tx = db.transaction((list) => {
    let n = 0;
    for (const id of list) n += upd.run(vocalStrm, accompStrm, id, vocalStrm, accompStrm).changes;
    return n;
  });
  const changed = tx(ids);
  stats.dbUpdatedSongs += changed;
  return changed;
}

// ============ 纯音乐 / 对齐门控 ============
function looksInstrumental(s) {
  const t = [s.title, s.artist, s.album].filter(Boolean).join(' ');
  return INSTRUMENTAL_RE.test(t);
}

// 单首歌是否满足清理门控：sep_done（调用方保证）AND (align_done OR 纯音乐)
function songEligible(s) {
  if (s.align_status === 'done') return true;
  if (looksInstrumental(s)) return true;
  return false;
}

// 整个 hash 是否可清理。返回 {eligible, reason}
function hashCleanupEligible(rows) {
  if (!rows || !rows.length) return { eligible: false, reason: '无歌曲' };
  for (const s of rows) {
    if (!songEligible(s)) {
      return { eligible: false, reason: `歌曲${s.id}(${s.artist||''}-${s.title||''}) align_status=${s.align_status}` };
    }
  }
  return { eligible: true };
}

// ============ 本地 FLAC 清理 ============
function cleanupLocalFlac(hash, dir, vocal, accomp, stats) {
  const targets = [vocal.filename, accomp.filename];
  for (const fn of targets) {
    const p = path.join(dir, fn);
    let size = 0;
    try { size = fs.statSync(p).size; } catch (e) { /* 已不存在 */ }
    if (!fs.existsSync(p)) continue;
    if (opts.dryRun) {
      log(`[CLEANUP][dry-run] ${hash}: 将删除本地FLAC ${fn} (${size} bytes)`);
      stats.cleanupDry++;
      continue;
    }
    try {
      fs.unlinkSync(p);
      log(`[CLEANUP] ${hash}: 删除本地FLAC ${fn} (${size} bytes)`);
      stats.cleanupDeletedBytes += size;
      stats.cleanupCount++;
    } catch (e) {
      log(`[CLEANUP-ERR] ${hash}: 删除 ${fn} 失败: ${e.message}`);
      stats.errors++;
    }
  }
}

// ============ 源文件删除（CUE 感知） ============
// 对该 hash 下所有歌曲的 filepath，逐个判断能否安全删除。
// 安全条件：
//   1. 扩展名在 DELETABLE_SRC_EXT（非 FLAC 音频）；
//   2. 共享同一 filepath 的所有歌曲全部满足 songEligible；
//   3. 文件确实存在。
function deleteSourceFiles(hash, rows, db, stats) {
  // 收集去重的 filepath
  const filepaths = new Set();
  for (const s of rows) {
    if (s.filepath) filepaths.add(s.filepath);
  }
  for (const fp of filepaths) {
    const ext = path.extname(fp).toLowerCase();
    if (!DELETABLE_SRC_EXT.has(ext)) {
      stats.sourceSkippedExt++;
      continue; // .flac / .mkv / .cue 等不删
    }
    if (!fs.existsSync(fp)) {
      stats.sourceSkippedMissing++;
      continue;
    }
    // 查所有共享该 filepath 的歌曲
    const shared = db.prepare(
      "SELECT id, align_status, title, artist FROM songs WHERE filepath=?"
    ).all(fp);
    // 逐首校验门控
    let allOk = true;
    let failReason = '';
    for (const s of shared) {
      if (s.align_status === 'done') continue;
      if (looksInstrumental(s)) continue;
      allOk = false;
      failReason = `歌曲${s.id}(${s.artist||''}-${s.title||''}) align_status=${s.align_status}`;
      break;
    }
    if (!allOk) {
      log(`[SKIP-DELETE-SOURCE] ${fp}: ${failReason} (共${shared.length}首共享)`);
      stats.sourceSkippedNotReady++;
      continue;
    }
    let size = 0;
    try { size = fs.statSync(fp).size; } catch (e) {}
    const idList = shared.map(s => s.id).join(',');
    if (opts.dryRun) {
      log(`[DELETE-SOURCE][dry-run] ${fp} (${size} bytes) - 歌曲${idList} (${shared.length}首)`);
      stats.sourceDry++;
      continue;
    }
    try {
      fs.unlinkSync(fp);
      log(`[DELETE-SOURCE] ${fp} (${size} bytes) - 歌曲${idList} (${shared.length}首)`);
      stats.sourceDeletedBytes += size;
      stats.sourceDeletedCount++;
    } catch (e) {
      log(`[DELETE-SOURCE-ERR] ${fp}: ${e.message}`);
      stats.errors++;
    }
  }
}

// ============ 处理单个 hash（上传+strm+DB+清理） ============
async function processHash(hash, token, db, hashMap, remoteDirSet, stats) {
  const dir = path.join(SEP_DIR, hash);
  const vocal = pickTrack(dir, 'vocals');
  const accomp = pickTrack(dir, 'accompaniment');
  if (!vocal || !accomp) {
    stats.noTrack++;
    log(`[跳过] ${hash}: 未找到人声/伴奏文件 (vocal=${vocal && vocal.filename} accomp=${accomp && accomp.filename})`);
    return { ok: false, reason: 'noTrack' };
  }

  const remoteDir = `${REMOTE_ROOT}/${hash}`;
  const remoteVocal = `${remoteDir}/${vocal.filename}`;
  const remoteAccomp = `${remoteDir}/${accomp.filename}`;
  const localVocal = path.join(dir, vocal.filename);
  const localAccomp = path.join(dir, accomp.filename);

  // 1. 远程目录
  let remoteFiles;
  if (remoteDirSet && remoteDirSet.has(hash)) {
    stats.remoteAlready++;
    remoteFiles = null;
  } else {
    remoteFiles = await listRemote(token, remoteDir);
    if (remoteFiles === null) {
      if (!opts.dryRun) {
        await mkdirRemote(token, remoteDir);
        stats.dirsNew++;
        remoteFiles = new Set();
      } else {
        remoteFiles = new Set();
      }
    }
  }

  // 2. 上传
  const toUpload = [];
  if (remoteFiles !== null) {
    if (!remoteFiles.has(vocal.filename)) toUpload.push([localVocal, remoteVocal]);
    if (!remoteFiles.has(accomp.filename)) toUpload.push([localAccomp, remoteAccomp]);
  } else {
    stats.uploadSkippedRemote++;
  }
  for (const [lp, rp] of toUpload) {
    if (opts.dryRun) {
      log(`  [dry-run] 将上传 ${path.basename(lp)} -> ${rp}`);
    } else {
      await uploadOne(token, lp, rp);
      stats.filesUploaded++;
      log(`  [上传] ${hash}/${path.basename(lp)} (${(fs.statSync(lp).size / 1048576).toFixed(1)} MB)`);
    }
  }

  // 同时上传 <hash>.lrc 逐字歌词文件（如果存在）
  const localLrc = path.join(dir, hash + '.lrc');
  const remoteLrc = `${remoteDir}/${hash}.lrc`;
  if (fs.existsSync(localLrc)) {
    const needUploadLrc = (remoteFiles === null) ? false : !remoteFiles.has(hash + '.lrc');
    if (needUploadLrc) {
      if (opts.dryRun) {
        log(`  [dry-run] 将上传 ${hash}.lrc -> ${remoteLrc}`);
      } else {
        await uploadOne(token, localLrc, remoteLrc);
        stats.filesUploaded++;
        log(`  [上传] ${hash}/${hash}.lrc (${(fs.statSync(localLrc).size / 1024).toFixed(1)} KB)`);
      }
    }
  }

  // 3. strm
  const vocalStrm = path.join(STRM_DIR, `${hash}_vocals.strm`);
  const accompStrm = path.join(STRM_DIR, `${hash}_accomp.strm`);
  if (!opts.dryRun) {
    writeStrmIfNeeded(hash, 'vocals', vocal.filename, stats);
    writeStrmIfNeeded(hash, 'accomp', accomp.filename, stats);
  } else {
    log(`  [dry-run] strm: ${vocalStrm}`);
    log(`  [dry-run] strm: ${accompStrm}`);
  }

  // 4. DB
  if (!opts.dryRun) {
    const changed = updateDbForHash(db, hash, hashMap, vocalStrm, accompStrm, stats);
    if (changed) log(`  [DB] ${hash}: 更新 ${changed} 首歌`);
  }

  // 5. 清理（仅在 --cleanup 且门控通过后）
  let cleaned = false;
  if (opts.cleanup) {
    const rows = hashMap.get(hash) || [];
    const chk = hashCleanupEligible(rows);
    if (!chk.eligible) {
      log(`[SKIP-CLEANUP] ${hash}: ${chk.reason}`);
    } else {
      cleanupLocalFlac(hash, dir, vocal, accomp, stats);
      cleaned = true;
      // 6. 源文件删除（--delete-source）
      if (opts.deleteSource) {
        deleteSourceFiles(hash, rows, db, stats);
      }
    }
  }

  return { ok: true, cleaned };
}

// ============ 守护进程 state ============
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    if (s && typeof s === 'object' && s.processed) return s;
  } catch (e) {}
  return { processed: {}, baseline_ts: null };
}
function saveState(state) {
  if (opts.dryRun) return;
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  } catch (e) {
    log(`[state-err] 保存 state 失败: ${e.message}`);
  }
}

function listLocalHashDirs() {
  return fs.readdirSync(SEP_DIR).filter((n) => /^[0-9a-f]{16}$/.test(n));
}

// ============ 单轮处理（daemon 和一次性共用） ============
async function runOnce(scopeDirs, label) {
  log(`=== ${label} 开始 ===`);
  log(`参数: cleanup=${opts.cleanup} deleteSource=${opts.deleteSource} dryRun=${opts.dryRun} daemon=${opts.daemon}`);

  if (!fs.existsSync(SEP_DIR)) throw new Error('分离目录不存在: ' + SEP_DIR);
  if (!fs.existsSync(STRM_DIR) && !opts.dryRun) fs.mkdirSync(STRM_DIR, { recursive: true });

  const token = await alistLogin();
  const db = loadDb();
  const hashMap = buildHashMap(db);
  log(`数据库: sep_done 歌曲映射到 ${hashMap.size} 个 hash`);

  let localDirs = scopeDirs.slice();
  localDirs.sort();
  if (Number.isFinite(opts.limit)) localDirs = localDirs.slice(0, opts.limit);
  log(`待处理目录数: ${localDirs.length}`);

  let remoteDirSet = new Set();
  try {
    remoteDirSet = await listRemoteDirNames(token, REMOTE_ROOT);
    log(`远程已存在目录数: ${remoteDirSet.size}`);
  } catch (e) {
    log(`[警告] 预取远程目录列表失败，将逐目录检查: ${e.message}`);
  }

  const stats = {
    dirsScanned: 0, filesUploaded: 0, dirsNew: 0,
    strmWritten: 0, strmSkipped: 0, dbUpdatedSongs: 0, dbNoSong: 0,
    noTrack: 0, errors: 0, remoteAlready: 0, uploadSkippedRemote: 0,
    cleanupCount: 0, cleanupDry: 0, cleanupDeletedBytes: 0,
    sourceDeletedCount: 0, sourceDry: 0, sourceDeletedBytes: 0,
    sourceSkippedExt: 0, sourceSkippedMissing: 0, sourceSkippedNotReady: 0,
  };

  for (const hash of localDirs) {
    stats.dirsScanned++;
    try {
      await processHash(hash, token, db, hashMap, remoteDirSet, stats);
    } catch (e) {
      stats.errors++;
      log(`[错误] ${hash}: ${e.message}`);
    }
    if (stats.dirsScanned % 100 === 0) {
      log(`进度: ${stats.dirsScanned}/${localDirs.length}  上传=${stats.filesUploaded} strm写=${stats.strmWritten} db更新=${stats.dbUpdatedSongs} 清FLAC=${stats.cleanupCount} 删源=${stats.sourceDeletedCount}`);
    }
  }

  log(`=== ${label} 完成 ===`);
  log(JSON.stringify(stats));
  if (opts.dryRun) log('(dry-run，未实际写盘/上传/删除/写库)');
  return stats;
}

// ============ 守护进程 ============
let shuttingDown = false;
async function runDaemon() {
  log('=== daemon 启动 ===');
  log(`cleanup=${opts.cleanup} deleteSource=${opts.deleteSource} interval=${DAEMON_INTERVAL_MS / 1000}s state=${STATE_FILE}`);

  const state = loadState();
  // 首次启动：把当前已存在的目录全部标记为"已见"，不处理不清理（保护存量）
  const existing = listLocalHashDirs();
  let baselineAdded = 0;
  for (const h of existing) {
    if (!state.processed[h]) {
      state.processed[h] = { ts: Date.now(), seen_only: true };
      baselineAdded++;
    }
  }
  state.baseline_ts = state.baseline_ts || Date.now();
  saveState(state);
  log(`daemon 基线: 当前已有 ${existing.length} 个目录标记为已见（不清理存量），新增 ${baselineAdded} 个基线条目`);

  const stop = () => {
    shuttingDown = true;
    log('收到退出信号，等待当前轮次结束...');
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  while (!shuttingDown) {
    const tickStart = Date.now();
    try {
      const nowLocal = listLocalHashDirs();
      const newDirs = nowLocal.filter((h) => !state.processed[h]);
      if (newDirs.length > 0) {
        log(`--- 新一轮: 发现 ${newDirs.length} 个新目录 ---`);
        await runOnce(newDirs, 'daemon-轮次');
        // 处理完后标记（即使失败也标记，避免死循环重试）
        for (const h of newDirs) {
          if (!state.processed[h]) state.processed[h] = { ts: Date.now() };
          else state.processed[h].ts = Date.now();
        }
        saveState(state);
      } else {
        log(`--- 轮询: 无新目录 (本地${nowLocal.length}，state已处理${Object.keys(state.processed).length}) ---`);
      }
    } catch (e) {
      log(`[daemon错误] ${e.message}`);
    }
    // 可中断的 sleep
    const elapsed = Date.now() - tickStart;
    const wait = Math.max(1000, DAEMON_INTERVAL_MS - elapsed);
    for (let t = 0; t < wait && !shuttingDown; t += 1000) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  saveState(state);
  log('=== daemon 已优雅退出 ===');
}

// ============ 入口 ============
async function main() {
  if (opts.daemon) {
    await runDaemon();
    return;
  }
  // 一次性模式：处理全部本地目录（受 --since / --limit 过滤）
  let localDirs = listLocalHashDirs();
  if (opts.since !== null) {
    localDirs = localDirs.filter((n) => {
      try { return fs.statSync(path.join(SEP_DIR, n)).mtimeMs >= opts.sinceMs; }
      catch (e) { return false; }
    });
  }
  await runOnce(localDirs, '一次性');
}

main().catch((e) => { log('致命错误: ' + (e.stack || e.message)); process.exit(1); });
