/**
 * cloud-lyrics.js —— 网盘歌词同步模块
 *
 * 功能：
 * 1. 获取并缓存 AList admin token
 * 2. 从网盘同级目录读取逐字歌词 (.lrc)
 * 3. 将 AI Worker 生成的逐字歌词上传到网盘同级目录
 *
 * 歌词文件名格式：歌手-歌名.lrc
 * 网盘路径映射：song.filepath 如 /KTV/music/xxx.mkv → AList 路径 /云盘/cmcc/我的移动云盘/KTV/music/
 *
 * 优先级：网盘 .lrc > DB lyrics_word > AI Worker 生成 > 网络抓取
 */

const http = require('http');
const https = require('https'); // 修 Bug-8：115 raw_url 的 302 目标常为 https CDN 链接
const lrcFileMod = require('./lrcFile'); // 复用其 extractSha，保证 hash 提取口径与本地 lrc 文件一致

const ALIST_URL = process.env.ALIST_INTERNAL_URL || process.env.ALIST_URL || 'http://localhost:5345';
const ALIST_USER = process.env.ALIST_ADMIN_USER || 'admin';
const ALIST_PASS = process.env.ALIST_ADMIN_PASS || 'admin123';

// AList 挂载路径映射（account_id -> AList 挂载根路径）
const ACCOUNT_MOUNT_MAP = {
  1: '/云盘/cmcc/我的移动云盘',   // 移动云盘（139Yun，AList 上传假成功，不可写）
  2: '/云盘/pan115/我的115',      // 115 云盘
};

// 修 Bug-1/Bug-2：分离产物（人声/伴奏 flac）在 115 上的固定根目录。
// 必须与 upload-separated-to-115.js 的 REMOTE_ROOT 严格一致，否则歌词与 flac 不在同一目录。
// 注意：分离产物统一上传到 115（与歌曲源盘无关），所以已分离歌曲的歌词也固定落在这里。
const SEPARATED_CLOUD_ROOT = '/云盘/pan115/我的115/momo-ktv/separated';

let _cachedToken = null;
let _tokenExpireAt = 0;

/**
 * 获取 AList admin token（带缓存）
 */
async function getAlistToken() {
  if (_cachedToken && Date.now() < _tokenExpireAt) {
    return _cachedToken;
  }
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ username: ALIST_USER, password: ALIST_PASS });
    const url = new URL(ALIST_URL + '/api/auth/login');
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.code === 200 && j.data && j.data.token) {
            _cachedToken = j.data.token;
            // token 有效期 48 小时，提前 1 小时刷新
            _tokenExpireAt = Date.now() + (47 * 3600 * 1000);
            resolve(_cachedToken);
          } else {
            reject(new Error('AList login failed: ' + (j.message || data)));
          }
        } catch (e) {
          reject(new Error('AList login parse error: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('AList login timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * 根据歌曲信息推断网盘同级目录的 AList 完整路径
 * 返回 null 表示无法推断（非网盘歌曲或路径不支持）
 */
function getCloudDirForSong(song) {
  // 只处理 audio 类型（用户要求 MKV 不处理）
  if (song.media_type !== 'audio') return null;

  // 修 Bug-1（根因）：只要歌曲已有分离产物，优先从 vocal_path/accomp_path
  // 提取 16-hex hash，歌词上传到分离产物目录 SEPARATED_CLOUD_ROOT/{hash}/，
  // 与该歌的人声/伴奏 flac 同目录。
  // hash 必须从 vocal/accomp_path 取（filepath 是 /data/music-strm/... 本地 strm，
  // 里面没有分离 hash）。两种 accomp 格式都由 lrcFile.extractSha 兼容：
  //   separated/{hash}/xxx.flac  或  /data/netseparated-strm/{hash}_vocals.strm
  const hash = lrcFileMod.extractSha(song.vocal_path) || lrcFileMod.extractSha(song.accomp_path);
  if (hash) {
    return SEPARATED_CLOUD_ROOT + '/' + hash;
  }

  // 以下为未分离歌曲（vocal_path/accomp_path 均为空）的 fallback：按 filepath 推断源文件同级目录
  // 优先使用 cloud_account_id 映射（默认 account 1 = 移动云盘）
  const accountId = song.cloud_account_id || 1;
  const mountRoot = ACCOUNT_MOUNT_MAP[accountId] || ACCOUNT_MOUNT_MAP[1];

  if (song.filepath) {
    // 情况1：网盘原始音频文件 /KTV/music/xxx.flac 或 /云盘/...
    if (song.filepath.startsWith('/KTV/') || song.filepath.startsWith('/云盘/')) {
      const parts = song.filepath.split('/');
      parts.pop();
      const dirPath = parts.join('/');
      if (song.filepath.startsWith('/云盘/')) return dirPath;
      return mountRoot + dirPath;
    }

    // 情况2：filepath 本身就是分离后的人声 .strm 文件 /data/netseparated-strm/{hash}_vocals.strm
    // 修 Bug-2：网盘对应目录补上 momo-ktv/ 一层（对齐 SEPARATED_CLOUD_ROOT）
    const strmMatch = song.filepath.match(/\/netseparated-strm\/([a-f0-9]+)_(vocals|accomp)\.strm$/);
    if (strmMatch) {
      return SEPARATED_CLOUD_ROOT + '/' + strmMatch[1];
    }
  }

  return null;
}

/**
 * 构造网盘歌词文件名：歌手-歌名.lrc
 */
function getLyricsFileName(song) {
  const artist = (song.artist || '未知歌手').trim();
  const title = (song.title || '未知歌曲').trim();
  // 清理文件名中的非法字符
  const clean = (s) => s.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
  return clean(artist) + '-' + clean(title) + '.lrc';
}

/**
 * 从网盘同级目录读取逐字歌词
 * 返回 { lrc, source } 或 null
 */
async function fetchCloudLyrics(song) {
  try {
    const dir = getCloudDirForSong(song);
    if (!dir) return null;

    const token = await getAlistToken();
    const fileName = getLyricsFileName(song);
    const filePath = dir + '/' + fileName;

    // 通过 AList fs/get 接口获取文件下载链接
    const body = JSON.stringify({ path: filePath, password: '' });
    const url = new URL(ALIST_URL + '/api/fs/get');
    const result = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Authorization': token,
        },
        timeout: 10000,
      }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body);
      req.end();
    });

    const j = JSON.parse(result);
    if (j.code !== 200 || !j.data || !j.data.raw_url) {
      return null; // 文件不存在
    }

    // 下载 .lrc 内容
    // 修 Bug-8：跟随 AList 115 raw_url 的 302 重定向（原先遇到 3xx 直接 resolve(null)，
    // 导致即使网盘里有 .lrc 也读不出来）
    const lrcContent = await downloadLrcByRedirect(j.data.raw_url, 3);

    if (lrcContent && lrcContent.length > 0) {
      return { lrc: lrcContent, source: 'cloud' };
    }
    return null;
  } catch (e) {
    console.error('[CloudLyrics] fetch failed:', e.message);
    return null;
  }
}

/**
 * 修 Bug-8：按 URL 下载文本内容，最多跟随 maxRedirects 次 3xx 重定向。
 * 同时支持 http/https（115 raw_url 经 AList 302 跳到的常是 https CDN 地址）。
 * 网络失败/超时一律 resolve(null)，由调用方走后续兜底，不抛出。
 */
function downloadLrcByRedirect(rawUrl, maxRedirects) {
  return new Promise((resolve) => {
    let left = maxRedirects;
    const step = (urlStr) => {
      const u = new URL(urlStr);
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        timeout: 15000,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume(); // 丢弃重定向响应体
          if (left-- > 0) {
            return step(new URL(res.headers.location, urlStr).toString());
          }
          resolve(null);
          return;
        }
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => resolve(data));
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    };
    step(rawUrl);
  });
}

/**
 * 上传逐字歌词到网盘分离产物目录
 * 返回 true/false
 */

async function uploadLyricsToCloud(song, lrcContent) {
  try {
    const dir = getCloudDirForSong(song);
    if (!dir) {
      console.log('[CloudLyrics] skip upload: no cloud dir for song', song.id);
      return false;
    }

    // 修 Bug-6/Bug-7：不再靠 dir.includes('cmcc'|'139'|'移动') 模糊字符串匹配
    // （会误杀 115 盘上目录名恰好含"移动"二字的歌）。改为精确判断目标目录是否
    // 落在移动云盘(139Yun)挂载点之下——该驱动 AList 上传假成功、实际不可写。
    // cloud_account_id 为 NULL 时也不再影响判断：只看最终目标 dir 在哪个挂载点下。
    const CMCC_ROOT = ACCOUNT_MOUNT_MAP[1]; // '/云盘/cmcc/我的移动云盘'
    if (dir === CMCC_ROOT || dir.startsWith(CMCC_ROOT + '/')) {
      console.log('[CloudLyrics] skip upload: target dir on cmcc(139Yun) read-only mount, dir=', dir);
      return false;
    }

    const token = await getAlistToken();
    const fileName = getLyricsFileName(song);
    const filePath = dir + '/' + fileName;

    // 修 Bug-5：上传前确保目标目录存在（对齐 upload-separated-to-115.js 的 mkdirRemote）。
    // 新分离的 hash 目录若尚未在 115 侧建好，fs/put 会直接失败；mkdir 失败也只记日志，
    // 真实成败交给下面 fs/put 的返回值判定。
    await ensureRemoteDir(token, dir);

    // 修 File-Path header 中文编码：Node.js 严格校验 HTTP header 必须是 Latin1，
    // 中文路径直接放进 File-Path 会抛 "Invalid character in header content"。
    // 与 upload-separated-to-115.js 的 encodeAlistPath 同样处理：逐段 encodeURIComponent。
    const encodedFilePath = encodeAlistPath(filePath);

    // 通过 AList fs/put 接口上传
    const result = await new Promise((resolve, reject) => {
      const u = new URL(ALIST_URL + '/api/fs/put');
      const req = http.request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'PUT',
        headers: {
          'Authorization': token,
          'File-Path': encodedFilePath,
          'Content-Type': 'application/octet-stream',
          'Content-Length': Buffer.byteLength(lrcContent, 'utf8'),
        },
        timeout: 30000,
      }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('upload timeout')); });
      req.write(lrcContent, 'utf8');
      req.end();
    });

    let j = null;
    try { j = JSON.parse(result.body); } catch (e) { /* ignore */ }

    if (result.status === 200 && j && j.code === 200) {
      console.log('[CloudLyrics] uploaded:', filePath);
      return true;
    }
    console.error('[CloudLyrics] upload failed:', result.status, result.body);
    return false;
  } catch (e) {
    console.error('[CloudLyrics] upload error:', e.message);
    return false;
  }
}

/**
 * 把 AList 虚拟路径逐段 encodeURIComponent，用于放进 File-Path HTTP header。
 * Node.js 严格校验 header 值必须是 Latin1，中文路径不编码会抛 Invalid character in header content。
 * 与 upload-separated-to-115.js 的 encodeAlistPath 行为一致。
 */
function encodeAlistPath(p) {
  return p.split('/').map((seg, i) => (i === 0 ? '' : encodeURIComponent(seg))).join('/');
}

/**
 * 修 Bug-5：调用 AList /api/fs/mkdir 确保远程目录存在。
 * 目录已存在/无权限等失败都只静默忽略——是否真能上传由 fs/put 结果判定。
 */
async function ensureRemoteDir(token, dir) {
  const body = JSON.stringify({ path: dir });
  await new Promise((resolve) => {
    const u = new URL(ALIST_URL + '/api/fs/mkdir');
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': token,
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.write(body);
    req.end();
  });
}

module.exports = {
  getAlistToken,
  getCloudDirForSong,
  getLyricsFileName,
  fetchCloudLyrics,
  uploadLyricsToCloud,
};
