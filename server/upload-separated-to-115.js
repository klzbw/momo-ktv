#!/usr/bin/env node
/**
 * upload-separated-to-115.js —— 分离产物上传 115 + 生成 STRM 指针 + 回写数据库
 *
 * 运行环境：momo-ktv 容器内（node，工作目录 /app）。
 *
 * 做什么：
 *   1. 扫描 /data/separated/<16位hash>/ 下所有人声/伴奏 FLAC。
 *   2. 通过 Alist API（容器内 http://127.0.0.1:5345）检查 115 上
 *      /云盘/pan115/我的115/momo-ktv/separated/<hash>/ 是否已有同名文件；
 *      缺失则 mkdir + PUT /api/fs/put 上传（File-Path 头按段 URL 编码）。
 *   3. 在 /data/netseparated-strm/ 生成 <hash>_vocals.strm / <hash>_accomp.strm，
 *      内容为 Alist /d/ 直链（不带认证，依赖 Alist 已开启匿名访问）：
 *        http://192.168.3.16:5345/d/<编码后的远程路径>/<编码后的文件名>
 *      已存在且内容一致则跳过（幂等）；内容不一致（旧 /dav/ 带密码格式）则覆盖修复。
 *   4. 回写 SQLite：把所有属于该 hash 的歌曲的 vocal_path / accomp_path
 *      指向上面两个 .strm 绝对路径。
 *
 * 幂等：重复运行不会重复上传、不会重复写 strm、数据库只在值变化时更新。
 *
 * 命令行：
 *   node upload-separated-to-115.js [--full] [--since <ts>] [--dry-run] [--limit N]
 *     --full        处理所有目录（默认即全量；此 flag 仅作显式声明）
 *     --since <ts>  只处理 mtime >= ts 的目录（ts 为 unix 秒或 ISO 时间）
 *     --dry-run     只打印计划，实际上传/写文件/写库都不执行
 *     --limit N     只处理前 N 个目录
 *
 * 日志：同时打印到 stdout 和追加到 /data/upload-115.log。
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
// 生成 strm 内容时用的对外地址（KTV 客户端要能访问到）
const ALIST_PUBLIC = process.env.ALIST_PUBLIC_BASE || 'http://192.168.3.16:5345';
// 115 在 Alist 里的虚拟路径根
const REMOTE_ROOT = process.env.REMOTE_ROOT || '/云盘/pan115/我的115/momo-ktv/separated';

const DATA_DIR = process.env.DATA_DIR || '/data';
const SEP_DIR = path.join(DATA_DIR, 'separated');
const STRM_DIR = path.join(DATA_DIR, 'netseparated-strm');
const DB_PATH = path.join(DATA_DIR, 'ktv.db');
const LOG_FILE = path.join(DATA_DIR, 'upload-115.log');

// ============ 命令行参数 ============
const argv = process.argv.slice(2);
const opts = { full: false, since: null, dryRun: false, limit: Infinity };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--full') opts.full = true;
  else if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--since') { opts.since = argv[++i]; }
  else if (a === '--limit') { opts.limit = parseInt(argv[++i], 10) || Infinity; }
  else { console.error('未知参数:', a); process.exit(2); }
}
if (opts.since !== null) {
  // 支持 unix 秒或 ISO 字符串
  const t = Number(opts.since);
  opts.sinceMs = Number.isFinite(t) && String(t).length <= 11 ? t * 1000 : Date.parse(opts.since);
  if (!Number.isFinite(opts.sinceMs)) { console.error('--since 无法解析:', opts.since); process.exit(2); }
}

// ============ 日志 ============
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) { /* 日志文件写不进去不影响主流程 */ }
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

// 带重试的 JSON API 调用
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

// 把 Alist 虚拟路径按段 URL 编码（保留前导 '/'），用于 File-Path 头和 /d/ 直链
function encodeAlistPath(p) {
  return p.split('/').map((seg, i) => (i === 0 ? '' : encodeURIComponent(seg))).join('/');
}

// 列出远程 separated/ 根目录下的所有子目录名（一次性分页预取），用于跳过已存在的目录。
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
    if (page > 20) break; // 安全上限
  }
  return names;
}

// 列出远程目录内容（文件名集合）。目录不存在时返回 null。
async function listRemote(token, remoteDir) {
  const json = await alistJson(token, 'POST', '/api/fs/list', {
    path: remoteDir, password: '', page: 1, per_page: 200, refresh: false,
  });
  if (json.code === 500 && /not found|no such|路径|directory/i.test(JSON.stringify(json.message || ''))) {
    return null;
  }
  if (json.code !== 200) {
    // 500 通常是目录不存在；其它错误也当不存在处理，让上层 mkdir
    return null;
  }
  const content = (json.data && json.data.content) || [];
  const set = new Set();
  for (const e of content) if (!e.is_dir) set.add(e.name);
  return set;
}

async function mkdirRemote(token, remoteDir) {
  const json = await alistJson(token, 'POST', '/api/fs/mkdir', { path: remoteDir });
  if (json.code !== 200) throw new Error('mkdir 失败 ' + remoteDir + ': ' + JSON.stringify(json));
}

// 上传单个本地文件到远程完整路径（remoteFullPath 未编码）
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
      // Alist put 成功通常返回 200 + {"code":200,...}；有时 204
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
// 在目录里找人声/伴奏文件：优先中文命名（含"人声"/"伴奏"的 .flac），回退 vocals.flac/accompaniment.flac
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
  // 回退旧命名
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
  // enc 以 '/' 开头；拼上 Alist 直链端点 /d/
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

// 构建 hash -> [songId...] 映射。
// 优先从 vocal_path 里解析 hash（兼容两种历史格式），解析不出来再用 sha256(filepath)[:16]。
function buildHashMap(db) {
  const rows = db.prepare("SELECT id, filepath, vocal_path FROM songs WHERE sep_status='done'").all();
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
    map.get(hash).push(r.id);
  }
  return map;
}

function updateDbForHash(db, hash, map, vocalStrm, accompStrm, stats) {
  const ids = map.get(hash);
  if (!ids || !ids.length) { stats.dbNoSong++; return 0; }
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

// ============ 主流程 ============
async function main() {
  log('=== upload-separated-to-115 开始 ===');
  log(`参数: full=${opts.full} since=${opts.since || '-'} dryRun=${opts.dryRun} limit=${opts.limit}`);
  log(`ALIST_API=${ALIST_API}  ALIST_PUBLIC=${ALIST_PUBLIC}`);
  log(`REMOTE_ROOT=${REMOTE_ROOT}`);

  if (!fs.existsSync(SEP_DIR)) throw new Error('分离目录不存在: ' + SEP_DIR);
  if (!fs.existsSync(STRM_DIR) && !opts.dryRun) fs.mkdirSync(STRM_DIR, { recursive: true });

  // 登录 Alist
  const token = await alistLogin();
  log('Alist 登录成功, token=' + token.slice(0, 16) + '...');

  // 打开数据库，构建 hash->songs 映射
  const db = loadDb();
  const hashMap = buildHashMap(db);
  log(`数据库: sep_done 歌曲映射到 ${hashMap.size} 个 hash`);

  // 列出本地所有分离目录。分离根目录下都是 16 位 hex 命名的目录，按名字过滤即可，
  // 不对每个目录做 statSync——该盘是慢挂载，2700 次 stat 要近 3 分钟。
  let localDirs = fs.readdirSync(SEP_DIR).filter((n) => /^[0-9a-f]{16}$/.test(n));
  // 过滤 since（需要 stat mtime，仅在指定 --since 时才做）
  if (opts.since !== null) {
    localDirs = localDirs.filter((n) => {
      try { return fs.statSync(path.join(SEP_DIR, n)).mtimeMs >= opts.sinceMs; }
      catch (e) { return false; }
    });
  }
  localDirs.sort();
  if (Number.isFinite(opts.limit)) localDirs = localDirs.slice(0, opts.limit);
  log(`待处理目录数: ${localDirs.length}`);

  // 预取远程已有的目录名集合：已存在的目录视为已上传，跳过逐目录文件检查与上传，
  // 只做 strm 生成/修复与数据库回写（这是全量迁移时的快路径）。
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
  };

  for (const hash of localDirs) {
    stats.dirsScanned++;
    const dir = path.join(SEP_DIR, hash);
    try {
      const vocal = pickTrack(dir, 'vocals');
      const accomp = pickTrack(dir, 'accompaniment');
      if (!vocal || !accomp) {
        stats.noTrack++;
        log(`[跳过] ${hash}: 未找到人声/伴奏文件 (vocal=${vocal && vocal.filename} accomp=${accomp && accomp.filename})`);
        continue;
      }

      const remoteDir = `${REMOTE_ROOT}/${hash}`;
      const remoteVocal = `${remoteDir}/${vocal.filename}`;
      const remoteAccomp = `${remoteDir}/${accomp.filename}`;
      const localVocal = path.join(dir, vocal.filename);
      const localAccomp = path.join(dir, accomp.filename);

      // 1. 检查远程目录。已在远程目录集里 -> 视为已上传，跳过逐目录文件列表与上传。
      let remoteFiles;
      if (remoteDirSet.has(hash)) {
        stats.remoteAlready++;
        remoteFiles = null; // null 表示"信任已上传"，不检查具体文件
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

      // 2. 上传缺失文件（仅对远程不存在或不在集合里的目录）
      const toUpload = [];
      if (remoteFiles !== null) {
        if (!remoteFiles.has(vocal.filename)) toUpload.push([localVocal, remoteVocal]);
        if (!remoteFiles.has(accomp.filename)) toUpload.push([localAccomp, remoteAccomp]);
      } else {
        // 信任路径：不重复上传
        stats.uploadSkippedRemote++;
      }
      for (const [lp, rp] of toUpload) {
        if (opts.dryRun) { log(`  [dry-run] 将上传 ${path.basename(lp)} -> ${rp}`); }
        else {
          await uploadOne(token, lp, rp);
          stats.filesUploaded++;
          log(`  [上传] ${hash}/${path.basename(lp)} (${(fs.statSync(lp).size / 1048576).toFixed(1)} MB)`);
        }
      }

      // 3. 生成 strm
      const vocalStrm = path.join(STRM_DIR, `${hash}_vocals.strm`);
      const accompStrm = path.join(STRM_DIR, `${hash}_accomp.strm`);
      if (!opts.dryRun) {
        writeStrmIfNeeded(hash, 'vocals', vocal.filename, stats);
        writeStrmIfNeeded(hash, 'accomp', accomp.filename, stats);
      } else {
        log(`  [dry-run] strm: ${vocalStrm}`);
        log(`  [dry-run] strm: ${accompStrm}`);
      }

      // 4. 回写数据库
      if (!opts.dryRun) {
        const changed = updateDbForHash(db, hash, hashMap, vocalStrm, accompStrm, stats);
        if (changed) log(`  [DB] ${hash}: 更新 ${changed} 首歌`);
      }

      if (stats.dirsScanned % 100 === 0) {
        log(`进度: ${stats.dirsScanned}/${localDirs.length}  上传=${stats.filesUploaded} strm写=${stats.strmWritten} strm跳=${stats.strmSkipped} db更新=${stats.dbUpdatedSongs}`);
      }
    } catch (e) {
      stats.errors++;
      log(`[错误] ${hash}: ${e.message}`);
    }
  }

  log('=== 完成 ===');
  log(JSON.stringify(stats, null, 2));
  if (opts.dryRun) log('(dry-run，未实际写盘/上传/写库)');
}

main().catch((e) => { log('致命错误: ' + (e.stack || e.message)); process.exit(1); });
