// catalog.js —— 曲库元数据"可移植快照"导入/导出（免重复 ffprobe 扫描）
//
// 解决的问题：3 万首歌逐首 ffprobe 探测时长/音轨很慢；扫一遍后把元数据导出成一份
// 快照文件（可跟歌曲放在同一目录/拷走），新机器全新安装时直接导入这份快照即可恢复
// 整张曲库，不需要重新扫描探测；之后只有"快照里没有的新歌"才走增量扫描。
//
// 可移植的关键：不要把"本机绝对路径"写死进快照。每首歌只锚定
//   - _root : 它属于哪个来源根目录（导出时的 source_root）
//   - _rel  : 相对该根的相对路径（等于 filename 里 '::' 之后那段）
// 导入到新机时，按"旧根 -> 新机根"映射，用与 scanner.stableTagFor 完全相同的算法
// 重算 tag，重建 filename=新tag::rel / filepath=新根/rel / source_root=新根——这样导入
// 进去的记录和"新机自己扫描出来的记录"filename 完全一致，以后增量扫描不会重复入库。
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// 必须和 scanner.js 的 stableTagFor 保持同一算法（改了两边要一起改）
function stableTagFor(dir, isNetwork) {
  const h = crypto.createHash('md5').update(dir).digest('hex').slice(0, 8);
  return (isNetwork ? 'N' : 'L') + h;
}

// 这些列属于"本机运行态 / 缓存 / 绑定本机文件系统的分离产物"，不可跨机移植，不导出
const SKIP_COLS = new Set([
  'id', 'created_at',                              // 自增主键/时间戳，新机自己生成
  'filename', 'filepath', 'source_root',           // 路径三件套，导入时按新根重建
  'cache_path', 'cache_status', 'cache_src_size', 'cache_src_mtime', // 本机缓存状态
  'vocal_path', 'accomp_path', 'sep_status',       // AI 分离产物在本机 /data，且与 GPU 机器绑定，新机重分离
]);

function songColumns(db) {
  return db.prepare('PRAGMA table_info(songs)').all().map(c => c.name);
}

// 把一条磁盘绝对路径里的"旧根前缀"替换成"新根前缀"（用于 cue_path 这类次级路径）
function remapPath(p, oldRoot, newRoot) {
  if (!p || typeof p !== 'string') return p;
  const norm = p.replace(/\\/g, '/');
  const o = (oldRoot || '').replace(/\\/g, '/');
  if (o && norm.startsWith(o)) return path.join(newRoot, norm.slice(o.length).replace(/^\/+/, ''));
  return p;
}

// 导出：返回纯对象（路由层负责下载/写文件）
function exportCatalog(db, roots) {
  const cols = songColumns(db).filter(c => !SKIP_COLS.has(c));
  const rows = db.prepare('SELECT * FROM songs').all();
  const rootList = (roots || []).map(r => ({ dir: r.dir, label: r.label || r.dir, isNetwork: !!r.isNetwork }));
  const songs = [];
  for (const s of rows) {
    const rootDir = s.source_root || '';
    let rel = '';
    if (typeof s.filename === 'string' && s.filename.includes('::')) rel = s.filename.split('::').slice(1).join('::');
    else if (rootDir && s.filepath) rel = path.relative(rootDir, s.filepath);
    else rel = s.filepath || '';
    const rec = { _rel: rel.split(path.sep).join('/'), _root: rootDir, _net: s.is_network ? 1 : 0 };
    for (const c of cols) {
      let v = s[c];
      if (c === 'cue_path') v = remapPath(v, rootDir, ''); // 导出时先剥成相对，占位（导入时再挂到新根）
      rec[c] = v === undefined ? null : v;
    }
    // cue_path 剥成相对根的路径，导入时再拼
    if (rec.cue_path && rootDir && s.cue_path) rec.cue_path = path.relative(rootDir, s.cue_path).split(path.sep).join('/');
    songs.push(rec);
  }
  return {
    format: 'momo-ktv-catalog', version: 1,
    app: '墨墨爱K歌 / momo-ktv',
    exported_at: new Date().toISOString(),
    roots: rootList, count: songs.length, songs,
  };
}

// 导出并写到文件（默认写到每个来源根目录下，跟歌曲放一起；同时始终在 /data 留一份）
function writeCatalogFiles(db, roots, dataDir) {
  const cat = exportCatalog(db, roots);
  const json = JSON.stringify(cat);
  const written = [];
  const dataCopy = path.join(dataDir || '/data', 'momo-catalog.json');
  fs.writeFileSync(dataCopy, json); written.push(dataCopy);
  for (const r of roots || []) {
    try {
      const p = path.join(r.dir, 'momo-catalog.json');
      fs.writeFileSync(p, json); written.push(p);
    } catch (e) { /* 某个根只读就跳过，不影响 /data 那份 */ }
  }
  return { bytes: Buffer.byteLength(json), written, count: cat.count };
}

// 旧根 -> 本机根 的解析：显式 mapping 优先；否则 dir 相同；再否则 basename 相同兜底
function resolveLocalRoot(oldRoot, isNet, localRoots, rootMap) {
  if (rootMap && rootMap[oldRoot]) {
    const hit = localRoots.find(r => r.dir === rootMap[oldRoot]);
    if (hit) return hit;
  }
  let hit = localRoots.find(r => r.dir === oldRoot);
  if (hit) return hit;
  const base = path.basename(oldRoot || '');
  if (base) hit = localRoots.find(r => path.basename(r.dir) === base);
  return hit || null;
}

// 导入快照。opts: { roots: 本机roots, rootMap, updateExisting(bool) }
// 不做任何 ffprobe——时长/音轨数等全部直接用快照里的值，这是"免扫描"的核心。
function importCatalog(db, cat, opts = {}) {
  if (!cat || cat.format !== 'momo-ktv-catalog' || !Array.isArray(cat.songs))
    throw new Error('不是有效的 momo-ktv 曲库快照文件');
  const localRoots = opts.roots || [];
  const rootMap = opts.rootMap || {};
  const updateExisting = opts.updateExisting !== false;
  const localCols = songColumns(db);

  // 动态构造 INSERT，只写本机表确实存在的列
  const valueCols = ['title', 'artist', 'language', 'genre', 'filename', 'filepath', 'source_root',
    'cover', 'duration', 'pinyin', 'play_count', 'audio_tracks', 'is_network', 'is_strm',
    'media_type', 'album', 'year', 'track_no', 'cue_path', 'cue_track', 'start_offset', 'end_offset',
    'lyrics', 'lyrics_word', 'lyrics_source', 'align_status',
    'audio_needs_soft', 'video_needs_soft'].filter(c => localCols.includes(c));
  const placeholders = valueCols.map(() => '?').join(',');
  const updateCols = valueCols.filter(c => c !== 'filename' && c !== 'play_count');
  const upsertSQL = `INSERT INTO songs (${valueCols.join(',')}) VALUES (${placeholders})
    ON CONFLICT(filename) DO ${updateExisting ? 'UPDATE SET ' + updateCols.map(c => c + '=excluded.' + c).join(',') : 'NOTHING'}`;
  const ins = db.prepare(upsertSQL);
  const findId = db.prepare('SELECT id FROM songs WHERE filename=?');

  let added = 0, updated = 0, skipped = 0, missingRoot = 0;
  const missingRoots = new Set();
  const tx = db.transaction((list) => {
    for (const rec of list) {
      const local = resolveLocalRoot(rec._root, rec._net, localRoots, rootMap);
      if (!local) { missingRoot++; missingRoots.add(rec._root || '(空)'); skipped++; continue; }
      const rel = (rec._rel || '').replace(/^\/+/, '');
      if (!rel) { skipped++; continue; }
      const tag = stableTagFor(local.dir, !!local.isNetwork);
      const filename = `${tag}::${rel}`;
      const filepath = path.join(local.dir, rel);
      let cuePath = null;
      if (rec.cue_path) cuePath = path.join(local.dir, rec.cue_path); // 快照里 cue_path 是相对根的
      const get = (c, dflt = null) => (rec[c] === undefined ? dflt : rec[c]);
      const vals = valueCols.map(c => {
        if (c === 'filename') return filename;
        if (c === 'filepath') return filepath;
        if (c === 'source_root') return local.dir;
        if (c === 'is_network') return local.isNetwork ? 1 : 0;
        if (c === 'cue_path') return cuePath;
        if (c === 'play_count') return get(c, 0);
        return get(c, null);
      });
      const existed = findId.get(filename);
      ins.run(...vals);
      if (existed) updated++; else added++;
    }
  });
  tx(cat.songs);
  return { total: cat.songs.length, added, updated, skipped, missingRoot, missingRoots: [...missingRoots] };
}

// 预览：快照里的根 分别能映射到本机哪个根（供前端在真正导入前确认/调整）
function previewRootMatch(cat, localRoots, rootMap = {}) {
  const seen = new Set(); const items = [];
  for (const rec of cat.songs || []) {
    if (seen.has(rec._root)) continue; seen.add(rec._root);
    const local = resolveLocalRoot(rec._root, rec._net, localRoots, rootMap);
    items.push({ snapshotRoot: rec._root, matched: local ? local.dir : null, ok: !!local });
  }
  return items;
}

module.exports = { stableTagFor, exportCatalog, writeCatalogFiles, importCatalog, previewRootMatch, songColumns };
