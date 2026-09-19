/**
 * 网络 KTV 标准扫描模块（AList 缓存层方案）
 *
 * 风控优化后的两阶段架构：
 *
 *  阶段一【定时同步 / 走 AList】：syncStrmViaAlist()
 *    - 通过内置 AList 的 /api/fs/list 列出网盘分离目录（不再直接调用网盘 driver API）
 *    - 网盘新增歌曲 → 在本地 /data/netseparated-strm 生成对应 .strm 文件（指向 AList DAV，播放 302 直连 CDN）
 *    - 网盘已删除歌曲 → 删除本地对应 .strm 文件并清理 DB 行
 *    - 由 index.js 按环境变量 NETKTV_SYNC_HOURS（默认 2 小时，钳制 1-5 小时）定时触发
 *
 *  阶段二【扫库入库 / 只读本地 strm】：importLocalStrm() / scanSeparatedFiles()
 *    - 扫码入库、手动点"扫描"时，直接扫描本地 .strm 目录入库，零网盘 API 调用
 *    - 从 .strm 内容（DAV URL）中解析真实文件名 → 歌手/歌名
 *    - 同时清理本地 strm 已缺失的孤儿 DB 行
 *
 * 115 分离文件目录结构：
 *   /momo-ktv/separated/<sha256前16位>/<歌手>-<歌名>-人声.flac
 *   /momo-ktv/separated/<sha256前16位>/<歌手>-<歌名>-伴奏.flac
 *
 * API：
 *   POST /api/netktv/scan        — 只读本地 strm 入库（不碰网盘）
 *   GET  /api/netktv/scan/status — 查询入库状态
 *   POST /api/netktv/sync-strm   — 立即通过 AList 同步网盘目录到本地 strm
 *   GET  /api/netktv/sync/status — 查询同步状态
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const lrcFileMod = require('./lrcFile');

const router = express.Router();

// 入库状态（扫本地 strm）
let scanStatus = {
  running: false,
  total: 0,
  processed: 0,
  added: 0,
  skipped: 0,
  errors: [],
  currentFile: null,
  startTime: null,
  endTime: null,
};

// 同步状态（走 AList 列网盘）
let syncStatus = {
  running: false,
  total: 0,
  processed: 0,
  createdStrm: 0,
  removedStrm: 0,
  addedSongs: 0,
  removedSongs: 0,
  errors: [],
  currentDir: null,
  startTime: null,
  endTime: null,
  message: '',
};

// ==================== AList 客户端（列目录唯一入口） ====================

let _alistToken = null;
let _alistTokenExpiry = 0;

function _alistBase() {
  return (process.env.ALIST_URL || 'http://127.0.0.1:5345').replace(/\/+$/, '');
}

async function _alistLogin(maxRetries = 5) {
  const password = process.env.ALIST_ADMIN_PASSWORD || process.env.ALIST_PASSWORD || 'admin123';
  const body = JSON.stringify({ username: 'admin', password });

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await new Promise((resolve, reject) => {
        const req = http.request(_alistBase() + '/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: 10000,
        }, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            try {
              const r = JSON.parse(data);
              if (r.code === 200 && r.data && r.data.token) resolve({ success: true, token: r.data.token });
              else resolve({ success: false, message: r.message || data });
            } catch (e) { reject(e); }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Alist 登录超时')); });
        req.write(body); req.end();
      });

      if (result.success) {
        _alistToken = result.token;
        _alistTokenExpiry = Date.now() + 47 * 3600 * 1000;
        console.log('[NETKTV-SYNC] AList 登录成功');
        return _alistToken;
      }
      if (result.message && result.message.includes('Loading storage')) {
        console.log(`[NETKTV-SYNC] AList 加载存储中，5s 后重试 (${attempt + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      throw new Error('Alist 登录失败: ' + result.message);
    } catch (e) {
      if (attempt < maxRetries - 1 && (e.message.includes('timeout') || e.message.includes('ECONNREFUSED'))) {
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      throw e;
    }
  }
  throw new Error('Alist 登录失败：超过最大重试次数');
}

async function _getAlistToken() {
  if (_alistToken && Date.now() < _alistTokenExpiry) return _alistToken;
  return await _alistLogin();
}

/**
 * 通过 AList /api/fs/list 列目录（分页）。
 * 这是本模块唯一访问网盘的途径，不直接调用网盘 driver API。
 * @param {string} alistPath AList 内路径
 * @param {{page?:number, perPage?:number, refresh?:boolean}} opts
 */
async function _alistListDir(alistPath, { page = 1, perPage = 100, refresh = false } = {}, retryAuth = true) {
  const token = await _getAlistToken();
  const postData = JSON.stringify({ path: alistPath, password: '', page, per_page: perPage, refresh });
  const result = await new Promise((resolve, reject) => {
    const req = http.request(_alistBase() + '/api/fs/list', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Authorization': token,
      },
      timeout: 8000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Alist 响应解析失败: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Alist 列目录超时: ' + alistPath)); });
    req.write(postData); req.end();
  });

  if (retryAuth && result.code === 401) {
    _alistToken = null;
    return _alistListDir(alistPath, { page, perPage, refresh }, false);
  }
  if (result.code !== 200) {
    throw new Error('Alist 列目录失败: ' + (result.message || JSON.stringify(result)));
  }
  return { content: (result.data && result.data.content) || [], total: (result.data && result.data.total) || 0 };
}

// ==================== 文件名解析 ====================

/**
 * 从文件名提取歌手和歌名
 * 格式：<歌手>-<歌名>-人声.flac 或 <歌手>-<歌名>-伴奏.flac
 */
function parseFilename(filename) {
  let name = filename.replace(/\.(flac|wav|mp3|m4a)$/i, '');
  name = name.replace(/-(人声|伴奏|vocals|accompaniment|instrumental)$/i, '');

  let artist = '未知';
  let title = name;
  const idx = name.indexOf('-');
  if (idx > 0) {
    artist = name.substring(0, idx).trim();
    title = name.substring(idx + 1).trim();
  }
  return { artist, title };
}

function isVocalFile(filename) {
  return /(人声|vocal|vocals|原唱)/i.test(filename) && /\.(flac|wav|mp3|m4a|ape|ogg|aac|wma|opus|aif|aiff|alac)$/i.test(filename);
}

function isAccompFile(filename) {
  return /(伴奏|accomp|accompaniment|instrumental|纯音乐)/i.test(filename) && /\.(flac|wav|mp3|m4a|ape|ogg|aac|wma|opus|aif|aiff|alac)$/i.test(filename);
}

// ==================== AList 路径 / strm 内容 ====================

/** 计算账号在 AList 中的挂载路径：/云盘/{driver}/{name}（可用 ALIST_MOUNT_BASE 覆盖） */
function _alistMountPath(account) {
  if (process.env.ALIST_MOUNT_BASE) return process.env.ALIST_MOUNT_BASE;
  return `/云盘/${account.driver}/${account.name}`;
}

/**
/**
 * 构造 AList 直链播放 URL（strm 文件正文）。
 * 使用 /d/ 直链端点（302 到网盘 CDN），不嵌入任何凭据。
 *
 * 【安全修复 P0】旧版使用 /dav/ WebDAV 端点并在 URL 中嵌入明文管理员密码
 * (http://admin:admin123@host:5345/dav/...)，任何能读取 .strm 文件的人都能
 * 拿到 Alist 管理员凭据。改为 /d/ 端点后，只需在 Alist 后台开启匿名访问，
 * strm 中完全不需要任何凭据，从根源消除密码泄露风险。
 *
 * 部署要求：Alist 后台 -> 设置 -> 开启「允许匿名访问」，访客勾选「可以访问」
 * 和「可以下载」。Alist /d/ 端点支持 Range 请求，ffmpeg/播放器可正常流式播放。
 */
function alistDavUrlForAccount(account, basePath, songKey, fileName) {
  const ext = (process.env.ALIST_EXTERNAL_URL || 'http://192.168.3.16:5345').replace(/\/+$/, '');
  const mount = _alistMountPath(account);
  const dir = (mount.replace(/\/+$/, '') + (basePath || ''));
  return ext + '/d' + encodeURI(dir + '/' + songKey + '/' + fileName) + '\n';
}

/** 兼容旧调用（无账号上下文时使用 env 默认挂载） */
function alistDavUrl(basePath, songKey, fileName) {
  const ext = (process.env.ALIST_EXTERNAL_URL || 'http://192.168.3.16:5345').replace(/\/+$/, '');
  const mount = process.env.ALIST_MOUNT_BASE || '/云盘/pan115/我的115';
  const dir = (mount.replace(/\/+$/, '') + (basePath || ''));
  return ext + '/d' + encodeURI(dir + '/' + songKey + '/' + fileName) + '\n';
}

// 通过 AList /d/ 直链下载小文本文件（.lrc）的内容。
// lrc 文件通常几 KB，超时 10s 足够。失败返回 null。
async function downloadTextViaAlist(alistBase, mountPath, basePath, songKey, fileName) {
  try {
    const ext = (process.env.ALIST_EXTERNAL_URL || alistBase).replace(/\/+$/, '');
    const dir = (mountPath.replace(/\/+$/, '') + (basePath || ''));
    const url = ext + '/d' + encodeURI(dir + '/' + songKey + '/' + fileName);
    const result = await new Promise((resolve, reject) => {
      const req = http.get(url, { timeout: 10000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          http.get(res.headers.location, { timeout: 10000 }, (res2) => {
            const chunks = [];
            res2.on('data', c => chunks.push(c));
            res2.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            res2.on('error', reject);
          }).on('error', reject);
          return;
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('lrc download timeout')); });
    });
    return result && result.trim() ? result : null;
  } catch (e) {
    console.warn('[NETKTV-SYNC] 下载 lrc 失败:', songKey, e.message);
    return null;
  }
}

// ==================== 阶段一：走 AList 同步网盘 → 本地 strm ====================

/**
 * 通过 AList 递归查找所有歌曲目录（16位十六进制目录名）。
 * 根目录用 refresh:true 强制从网盘拉最新，以发现新增/删除。
 */
async function findSongDirsViaAlist(alistRootPath, depth = 0, maxDepth = 5) {
  if (depth > maxDepth) return [];
  const results = [];
  try {
    const refresh = depth === 0;
    let page = 1;
    let allItems = [];
    let total = 0;
    do {
      const r = await _alistListDir(alistRootPath, { page, perPage: 100, refresh });
      allItems = allItems.concat(r.content);
      total = r.total;
      if (r.content.length < 100) break;
      page++;
    } while (allItems.length < total);

    for (const item of allItems) {
      if (!item.is_dir) continue;
      const fullPath = alistRootPath === '/' ? '/' + item.name : alistRootPath + '/' + item.name;
      if (/^[a-f0-9]{16}$/i.test(item.name)) {
        results.push({ name: item.name, fullPath });
      } else {
        const sub = await findSongDirsViaAlist(fullPath, depth + 1, maxDepth);
        results.push(...sub);
      }
    }
  } catch (e) {
    console.warn(`[NETKTV-SYNC] AList 递归查找失败 ${alistRootPath}:`, e.message);
  }
  return results;
}

/**
 * 通过 AList 同步单个账号的分离歌曲目录到本地 strm。
 *  - 新增歌曲目录（含人声+伴奏）→ 写本地 .strm 并入库
 *  - 网盘已删除歌曲目录 → 删本地 .strm 并删 DB 行
 * 全程只走 AList /api/fs/list，不直接调用网盘 driver API。
 *
 * @returns {Promise<object>} 同步统计
 */
async function syncStrmViaAlist(cloudDrive, accountId, basePath, db, strmDir, sourceRoot = 'netktv') {
  const manager = cloudDrive.manager;
  const account = manager.getAccount(accountId);
  if (!account) throw new Error(`账号不存在: ${accountId}`);

  const mountPath = _alistMountPath(account);
  const alistRoot = mountPath.replace(/\/+$/, '') + (basePath || '');
  console.log(`[NETKTV-SYNC] 开始: ${alistRoot} (账号=${account.name}, sourceRoot=${sourceRoot})`);

  if (!fs.existsSync(strmDir)) fs.mkdirSync(strmDir, { recursive: true });

  // 置位运行状态（启动自动同步不经路由，这里兜底保证 /sync/status 准确）
  syncStatus.running = true;

  try {
    const songDirs = await findSongDirsViaAlist(alistRoot);
  const presentKeys = new Set();
  let createdStrm = 0, removedStrm = 0, addedSongs = 0, removedSongs = 0;

  syncStatus.total = songDirs.length;
  syncStatus.processed = 0;

  for (const dirInfo of songDirs) {
    const songKey = dirInfo.name;
    presentKeys.add(songKey);
    syncStatus.currentDir = songKey;
    syncStatus.processed++;

    try {
      // 歌曲目录内文件用 AList 缓存（refresh:false），减少网盘调用
      const r = await _alistListDir(dirInfo.fullPath, { page: 1, perPage: 100, refresh: false });
      const files = (r.content || []).filter(f => !f.is_dir);
      const vocalFile = files.find(f => isVocalFile(f.name));
      const accompFile = files.find(f => isAccompFile(f.name));
      if (!vocalFile || !accompFile) {
        console.log(`[NETKTV-SYNC] 跳过 ${songKey}: 人声=${!!vocalFile} 伴奏=${!!accompFile}`);
        continue;
      }

      // 检测同目录下的 .lrc 逐字歌词文件（<sha>.lrc）
      const lrcFile = files.find(f => /\.lrc$/i.test(f.name));
      let lrcContent = null;
      if (lrcFile) {
        lrcContent = await downloadTextViaAlist(_alistBase(), mountPath, basePath, songKey, lrcFile.name);
      }

      const vPath = path.join(strmDir, `${songKey}_vocals.strm`);
      const aPath = path.join(strmDir, `${songKey}_accomp.strm`);
      const vContent = alistDavUrlForAccount(account, basePath, songKey, vocalFile.name);
      const aContent = alistDavUrlForAccount(account, basePath, songKey, accompFile.name);

      // 幂等：内容一致则不重写
      let vChanged = true, aChanged = true;
      try {
        if (fs.existsSync(vPath) && fs.readFileSync(vPath, 'utf-8') === vContent) vChanged = false;
        if (fs.existsSync(aPath) && fs.readFileSync(aPath, 'utf-8') === aContent) aChanged = false;
      } catch (e) { /* 读失败则重写 */ }
      if (vChanged) { fs.writeFileSync(vPath, vContent); createdStrm++; }
      if (aChanged) { fs.writeFileSync(aPath, aContent); createdStrm++; }

      // 入库（幂等）
      const meta = parseFilename(vocalFile.name);
      const existing = db.prepare(
        'SELECT id FROM songs WHERE source_root = ? AND cloud_account_id = ? AND filepath LIKE ?'
      ).get(sourceRoot, accountId, `%${songKey}_vocals.strm%`);

      if (!existing) {
        const now = new Date().toISOString();
        const result = db.prepare(`
          INSERT INTO songs (title, artist, filename, filepath, vocal_path, accomp_path, source_root, is_network, is_strm, media_type, audio_tracks, sep_status, align_status, lyrics_word, lyrics_source, cloud_account_id, duration, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 'audio', 2, 'done', ?, ?, ?, ?, ?, ?)
        `).run(
          meta.title, meta.artist, `${songKey}_vocals.strm`, vPath, vPath, aPath,
          sourceRoot, accountId,
          lrcContent ? 'done' : 'none', lrcContent, lrcContent ? 'lrc-file' : null,
          null, now
        );
        db.prepare('INSERT OR IGNORE INTO song_artists (song_id, artist) VALUES (?, ?)').run(result.lastInsertRowid, meta.artist);
        addedSongs++;
        console.log(`[NETKTV-SYNC] 新增: ${meta.artist} - ${meta.title} (id=${result.lastInsertRowid})${lrcContent ? ' [含逐字歌词]' : ''}`);
      } else if (lrcContent) {
        // 已入库但缺逐字歌词 -> 补写
        const upd = db.prepare(
          "UPDATE songs SET lyrics_word=?, align_status='done', lyrics_source='lrc-file' WHERE id=? AND (lyrics_word IS NULL OR lyrics_word='' OR align_status != 'done')"
        ).run(lrcContent, existing.id);
        if (upd.changes > 0) console.log(`[NETKTV-SYNC] 补写逐字歌词: id=${existing.id}`);
      }
    } catch (e) {
      console.warn(`[NETKTV-SYNC] 处理 ${songKey} 失败:`, e.message);
      syncStatus.errors.push({ dir: songKey, error: e.message });
    }
  }

  // 删除网盘已不存在的歌曲对应的本地 strm（仅删本账号挂载下的，避免误删其他账号）
  const encodedMount = encodeURI(mountPath);
  let localFiles = [];
  try { localFiles = fs.readdirSync(strmDir); } catch (e) { /* ignore */ }
  for (const f of localFiles) {
    const m = f.match(/^([a-f0-9]{16})_(vocals|accomp)\.strm$/i);
    if (!m) continue;
    const key = m[1];
    if (presentKeys.has(key)) continue;
    // 读内容确认属于本账号（DAV URL 中含本账号编码后的挂载路径）
    try {
      const content = fs.readFileSync(path.join(strmDir, f), 'utf-8');
      if (!content.includes(encodedMount)) continue;
    } catch (e) { continue; }
    try { fs.unlinkSync(path.join(strmDir, f)); removedStrm++; } catch (e) { /* ignore */ }
    // 仅删除 vocals 侧的 DB 行（accomp 随歌曲一起删）
    if (m[2] === 'vocals') {
      try {
        const del = db.prepare(
          'DELETE FROM songs WHERE source_root = ? AND cloud_account_id = ? AND filename = ?'
        ).run(sourceRoot, accountId, `${key}_vocals.strm`);
        removedSongs += del.changes;
      } catch (e) { /* ignore */ }
    }
  }

  syncStatus.createdStrm = createdStrm;
  syncStatus.removedStrm = removedStrm;
  syncStatus.addedSongs = addedSongs;
  syncStatus.removedSongs = removedSongs;
  console.log(`[NETKTV-SYNC] 完成: 目录=${songDirs.length} 新增strm=${createdStrm} 删除strm=${removedStrm} 入库=${addedSongs} 删库=${removedSongs}`);

  return { songDirs: songDirs.length, createdStrm, removedStrm, addedSongs, removedSongs };
  } finally {
    syncStatus.running = false;
  }
}

/**
 * 遍历所有 active 账号，逐一通过 AList 同步。
 */
async function syncAllAccounts(cloudDrive, basePath, db, strmDir, sourceRoot = 'netktv') {
  const manager = cloudDrive.manager;
  const activeAccounts = manager.listAccounts().filter(a => a.status === 'active');
  console.log(`[NETKTV-SYNC] 识别到 ${activeAccounts.length} 个 active 账号，逐一通过 AList 同步`);

  let totals = { songDirs: 0, createdStrm: 0, removedStrm: 0, addedSongs: 0, removedSongs: 0 };
  for (const account of activeAccounts) {
    console.log(`\n[NETKTV-SYNC] ===== 账号: ${account.name} (ID=${account.id}) =====`);
    try {
      const r = await syncStrmViaAlist(cloudDrive, account.id, basePath, db, strmDir, sourceRoot);
      for (const k of Object.keys(totals)) totals[k] += (r[k] || 0);
    } catch (e) {
      console.error(`[NETKTV-SYNC] 账号 ${account.name} 同步失败:`, e.message);
      syncStatus.errors.push({ dir: account.name, error: e.message });
    }
  }
  console.log(`\n[NETKTV-SYNC] ===== 全部完成:`, totals, '=====');
  return totals;
}

// ==================== 在线音乐扫描（单轨音乐文件，非KTV双轨） ====================

const MUSIC_EXT_RE = /\.(flac|wav|mp3|m4a|ape|ogg|aac|wma|opus|aif|aiff|alac)$/i;

async function syncMusicViaAlist(cloudDrive, accountId, basePath, db, strmDir, sourceRoot = 'netktv-music') {
  const manager = cloudDrive.manager;
  const account = manager.getAccount(accountId);
  if (!account) throw new Error('账号不存在: ' + accountId);

  const mountPath = _alistMountPath(account);
  const alistRoot = mountPath.replace(/\/+$/, '') + (basePath || '');
  console.log('[MUSIC-SYNC] 开始递归扫描: ' + alistRoot + ' (账号=' + account.name + ', sourceRoot=' + sourceRoot + ')');

  if (!fs.existsSync(strmDir)) fs.mkdirSync(strmDir, { recursive: true });
  syncStatus.running = true;

  let totalFiles = 0;
  let createdStrm = 0;
  let addedSongs = 0;
  let skipped = 0;

  try {
    // 递归扫描子目录
    async function walkDir(alistPath, relDir) {
      const r = await _alistListDir(alistPath, { page: 1, perPage: 1000, refresh: true });
      const items = r.content || [];
      for (const item of items) {
        if (item.is_dir) {
          // 递归子目录
          await walkDir(alistPath + '/' + item.name, relDir ? relDir + '/' + item.name : item.name);
        } else if (MUSIC_EXT_RE.test(item.name)) {
          totalFiles++;
          syncStatus.processed = totalFiles;
          const relPath = relDir ? relDir + '/' + item.name : item.name;
          try {
            const meta = parseFilename(item.name);
            // 用相对路径生成安全文件名，避免重名冲突
            const safeName = relPath.replace(/[\\/:*?"<>|]/g, '_');
            const strmPath = path.join(strmDir, safeName + '.strm');
            const strmContent = alistDavUrlForAccount(account, basePath, relDir || '', item.name);

            let changed = true;
            try {
              if (fs.existsSync(strmPath) && fs.readFileSync(strmPath, 'utf-8') === strmContent) changed = false;
            } catch (e) {}
            if (changed) { fs.writeFileSync(strmPath, strmContent); createdStrm++; }

            const existing = db.prepare(
              'SELECT id FROM songs WHERE source_root = ? AND cloud_account_id = ? AND filename = ?'
            ).get(sourceRoot, accountId, safeName + '.strm');

            if (!existing) {
              const now = new Date().toISOString();
              const result = db.prepare(
                'INSERT INTO songs (title, artist, filename, filepath, vocal_path, accomp_path, source_root, is_network, is_strm, media_type, audio_tracks, sep_status, cloud_account_id, duration, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, 1, 1, "audio", 1, "done", ?, NULL, ?)'
              ).run(
                meta.title, meta.artist, safeName + '.strm', strmPath, strmPath,
                sourceRoot, accountId, now
              );
              db.prepare('INSERT OR IGNORE INTO song_artists (song_id, artist) VALUES (?, ?)').run(result.lastInsertRowid, meta.artist);
              addedSongs++;
            } else {
              skipped++;
            }
          } catch (e) {
            console.warn('[MUSIC-SYNC] 处理 ' + relPath + ' 失败:', e.message);
            syncStatus.errors.push({ dir: relPath, error: e.message });
          }
        }
      }
    }

    await walkDir(alistRoot, '');

    syncStatus.createdStrm = createdStrm;
    syncStatus.addedSongs = addedSongs;
    console.log('[MUSIC-SYNC] 完成: 文件=' + totalFiles + ' 新增strm=' + createdStrm + ' 入库=' + addedSongs + ' 跳过=' + skipped);
    return { files: totalFiles, createdStrm, addedSongs, skipped };
  } finally {
    syncStatus.running = false;
  }
}


// ==================== 阶段二：只读本地 strm 入库 ====================

/**
 * 扫描本地 strm 目录入库（零网盘调用）。
 *  - 从 <songKey>_vocals.strm 文件名取 songKey
 *  - 从 strm 正文（DAV URL）解析真实文件名 → 歌手/歌名
 *  - 同时清理本地 strm 已缺失的孤儿 DB 行
 */
function importLocalStrm(db, strmDir, accountId, sourceRoot = 'netktv') {
  if (!fs.existsSync(strmDir)) {
    console.log('[NETKTV-IMPORT] strm 目录不存在，跳过:', strmDir);
    return { added: 0, pruned: 0, total: 0 };
  }

  let files = [];
  try { files = fs.readdirSync(strmDir); } catch (e) { return { added: 0, pruned: 0, total: 0 }; }
  const vocalFiles = files.filter(f => /^[a-f0-9]{16}_vocals\.strm$/i.test(f));

  let added = 0, pruned = 0;
  for (const f of vocalFiles) {
    const songKey = f.match(/^([a-f0-9]{16})_vocals\.strm$/i)[1];
    const vocalStrmPath = path.join(strmDir, f);
    const accompStrmPath = path.join(strmDir, `${songKey}_accomp.strm`);

    try {
      const existing = db.prepare(
        'SELECT id FROM songs WHERE source_root = ? AND cloud_account_id = ? AND filepath LIKE ?'
      ).get(sourceRoot, accountId, `%${songKey}_vocals.strm%`);
      if (existing) continue;

      // 从 strm 正文解析真实文件名（DAV URL 最后一段）
      let content = '';
      try { content = fs.readFileSync(vocalStrmPath, 'utf-8'); } catch (e) { continue; }
      const seg = content.split('/');
      const vocalFileName = decodeURIComponent((seg[seg.length - 1] || '').trim());
      const meta = vocalFileName ? parseFilename(vocalFileName) : { title: songKey, artist: '未知' };

      const now = new Date().toISOString();
      const result = db.prepare(`
        INSERT INTO songs (title, artist, filename, filepath, vocal_path, accomp_path, source_root, is_network, is_strm, media_type, audio_tracks, sep_status, cloud_account_id, duration, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 'audio', 2, 'done', ?, ?, ?)
      `).run(
        meta.title, meta.artist, f, vocalStrmPath, vocalStrmPath,
        fs.existsSync(accompStrmPath) ? accompStrmPath : '',
        sourceRoot, accountId, null, now
      );
      db.prepare('INSERT OR IGNORE INTO song_artists (song_id, artist) VALUES (?, ?)').run(result.lastInsertRowid, meta.artist);
      added++;
    } catch (e) {
      console.warn(`[NETKTV-IMPORT] 导入 ${f} 失败:`, e.message);
    }
  }

  // 清理孤儿 DB 行：本账号本 sourceRoot 下，对应 strm 文件已不存在
  try {
    const rows = db.prepare('SELECT id, filename FROM songs WHERE source_root = ? AND cloud_account_id = ?').all(sourceRoot, accountId);
    for (const row of rows) {
      if (!row.filename) continue;
      if (!fs.existsSync(path.join(strmDir, row.filename))) {
        db.prepare('DELETE FROM songs WHERE id = ?').run(row.id);
        pruned++;
      }
    }
  } catch (e) { /* ignore */ }

  console.log(`[NETKTV-IMPORT] 完成: strm=${vocalFiles.length} 新增=${added} 清理孤儿=${pruned}`);
  return { added, pruned, total: vocalFiles.length };
}

/**
 * 扫库入库入口（保持旧签名，供 /api/netktv/scan 与 index.js 管理后台调用）。
 * 现在只读本地 strm 目录，不直接调用网盘 API。
 */
async function scanSeparatedFiles(cloudDrive, accountId, basePath, db, strmDir, sourceRoot = 'netktv') {
  scanStatus = {
    running: true,
    total: 0,
    processed: 0,
    added: 0,
    skipped: 0,
    errors: [],
    currentFile: null,
    startTime: new Date(),
    endTime: null,
  };

  try {
    const manager = cloudDrive.manager;
    const account = manager.getAccount(accountId);
    if (!account) throw new Error(`账号不存在: ${accountId}`);

    console.log(`[NETKTV-SCAN] 扫本地 strm 入库 (账号=${account.name}, sourceRoot=${sourceRoot}, dir=${strmDir})`);
    const r = importLocalStrm(db, strmDir, accountId, sourceRoot);
    scanStatus.total = r.total;
    scanStatus.processed = r.total;
    scanStatus.added = r.added;
    scanStatus.skipped = r.total - r.added;
  } catch (e) {
    console.error('[NETKTV-SCAN] 扫描失败:', e);
    scanStatus.errors.push({ dir: 'ROOT', error: e.message });
  } finally {
    scanStatus.running = false;
    scanStatus.currentFile = null;
    scanStatus.endTime = new Date();
  }
  return scanStatus;
}

/**
 * 遍历所有 active 账号逐一扫本地 strm 入库。
 */
async function scanAllAccounts(cloudDrive, basePath, db, strmDir) {
  const manager = cloudDrive.manager;
  const activeAccounts = manager.listAccounts().filter(a => a.status === 'active');
  console.log(`[NETKTV-SCAN] 识别到 ${activeAccounts.length} 个 active 账号，扫本地 strm 入库`);

  let totalAdded = 0, totalPruned = 0;
  for (const account of activeAccounts) {
    console.log(`\n[NETKTV-SCAN] ===== 账号: ${account.name} (ID=${account.id}) =====`);
    const r = importLocalStrm(db, strmDir, account.id, 'netktv');
    totalAdded += r.added;
    totalPruned += r.pruned;
  }
  console.log(`\n[NETKTV-SCAN] ===== 全部完成: 新增=${totalAdded} 清理=${totalPruned} =====`);
  return { totalAdded, totalPruned, accountCount: activeAccounts.length };
}

// ==================== 路由 ====================

/**
 * 初始化模块
 */
function init(db, cloudDrive) {
  const DATA_DIR = process.env.DATA_DIR || '/data';
  const STRM_DIR = path.join(DATA_DIR, 'netseparated-strm');

  // POST /api/netktv/scan — 扫本地 strm 入库（不碰网盘）
  router.post('/scan', async (req, res) => {
    if (scanStatus.running) {
      return res.status(409).json({ error: '扫描正在进行中', status: scanStatus });
    }
    const { accountId = 0, basePath = '/momo-ktv/separated' } = req.body || {};

    if (!accountId || accountId === 0) {
      scanAllAccounts(cloudDrive, basePath, db, STRM_DIR).catch(e => console.error('[NETKTV-SCAN] 全账号扫描异常:', e));
      res.json({ ok: true, message: '已开始扫本地 strm 入库（全账号）', mode: 'all-accounts' });
    } else {
      scanSeparatedFiles(cloudDrive, accountId, basePath, db, STRM_DIR).catch(e => console.error('[NETKTV-SCAN] 异步扫描异常:', e));
      res.json({ ok: true, message: '已开始扫本地 strm 入库', status: scanStatus, accountId });
    }
  });

  // GET /api/netktv/scan/status — 入库状态
  router.get('/scan/status', (req, res) => {
    res.json(scanStatus);
  });

  // POST /api/netktv/sync-strm — 立即通过 AList 同步网盘目录到本地 strm
  router.post('/sync-strm', async (req, res) => {
    if (syncStatus.running) {
      return res.status(409).json({ error: 'AList 同步正在进行中', status: syncStatus });
    }
    const { accountId = 0, basePath = '/momo-ktv/separated' } = req.body || {};
    syncStatus = {
      running: true, total: 0, processed: 0, createdStrm: 0, removedStrm: 0,
      addedSongs: 0, removedSongs: 0, errors: [], currentDir: null,
      startTime: new Date(), endTime: null, message: '正在通过 AList 同步网盘目录...',
    };

    const done = () => {
      syncStatus.running = false;
      syncStatus.currentDir = null;
      syncStatus.endTime = new Date();
    };

    if (!accountId || accountId === 0) {
      syncAllAccounts(cloudDrive, basePath, db, STRM_DIR).then(() => {
        syncStatus.message = '全账号 AList 同步完成';
        done();
      }).catch(e => {
        console.error('[NETKTV-SYNC] 全账号同步异常:', e);
        syncStatus.message = '失败: ' + e.message;
        done();
      });
      res.json({ ok: true, message: '已开始通过 AList 同步（全账号）', mode: 'all-accounts' });
    } else {
      syncStrmViaAlist(cloudDrive, accountId, basePath, db, STRM_DIR).then(() => {
        syncStatus.message = 'AList 同步完成';
        done();
      }).catch(e => {
        console.error('[NETKTV-SYNC] 同步异常:', e);
        syncStatus.message = '失败: ' + e.message;
        done();
      });
      res.json({ ok: true, message: '已开始通过 AList 同步', status: syncStatus, accountId });
    }
  });

  // GET /api/netktv/sync/status — 同步状态
  router.get('/sync/status', (req, res) => {
    res.json(syncStatus);
  });

  // GET /api/netktv/music/list — 列出在线音乐（source_root=netktv-music）
  router.get('/music/list', (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 100, 500);
      const offset = parseInt(req.query.offset) || 0;
      const songs = db.prepare(
        "SELECT id, title, artist, filename, cloud_account_id, duration FROM songs WHERE source_root='netktv-music' ORDER BY id DESC LIMIT ? OFFSET ?"
      ).all(limit, offset);
      const total = db.prepare("SELECT COUNT(*) as cnt FROM songs WHERE source_root='netktv-music'").get();
      res.json({ songs, total: total.cnt });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/netktv/music/stream/:id — 302到AList直链播放
  router.get('/music/stream/:id', (req, res) => {
    try {
      const song = db.prepare("SELECT * FROM songs WHERE id=? AND source_root='netktv-music'").get(parseInt(req.params.id, 10));
      if (!song) return res.status(404).json({ error: '歌曲不存在' });
      if (!song.vocal_path || !fs.existsSync(song.vocal_path)) {
        return res.status(404).json({ error: 'STRM文件不存在' });
      }
      const strmContent = fs.readFileSync(song.vocal_path, 'utf-8').trim();
      if (!strmContent.startsWith('http')) return res.status(500).json({ error: 'STRM内容无效' });
      // 直接302到AList直链（AList再302到CDN），不占NAS带宽
      res.redirect(302, strmContent);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/netktv/sync-music — 同步网盘音乐目录（单轨，在线音乐用）
  router.post('/sync-music', async (req, res) => {
    if (syncStatus.running) {
      return res.status(409).json({ error: '同步正在进行中', status: syncStatus });
    }
    const { accountId = 0, basePath = '/music' } = req.body || {};
    syncStatus = {
      running: true, total: 0, processed: 0, createdStrm: 0, removedStrm: 0,
      addedSongs: 0, removedSongs: 0, errors: [], currentDir: null,
      startTime: new Date(), endTime: null, message: '正在通过 AList 同步音乐目录...',
    };
    const done = () => {
      syncStatus.running = false;
      syncStatus.currentDir = null;
      syncStatus.endTime = new Date();
    };
    if (!accountId || accountId === 0) {
      return res.status(400).json({ error: '需要指定 accountId' });
    }
    syncMusicViaAlist(cloudDrive, accountId, basePath, db, STRM_DIR).then(() => {
      syncStatus.message = '音乐同步完成';
      done();
    }).catch(e => {
      console.error('[MUSIC-SYNC] 异常:', e);
      syncStatus.message = '失败: ' + e.message;
      done();
    });
    res.json({ ok: true, message: '已开始同步音乐目录', status: syncStatus, accountId });
  });

  return router;
}

module.exports = {
  init,
  router,
  scanSeparatedFiles,
  scanAllAccounts,
  syncStrmViaAlist,
  syncAllAccounts,
  syncMusicViaAlist,
  importLocalStrm,
  parseFilename,
};
