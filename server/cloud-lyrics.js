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

const ALIST_URL = process.env.ALIST_INTERNAL_URL || process.env.ALIST_URL || 'http://localhost:5345';
const ALIST_USER = process.env.ALIST_ADMIN_USER || 'admin';
const ALIST_PASS = process.env.ALIST_ADMIN_PASS || 'admin123';

// AList 挂载路径映射（account_id -> AList 挂载根路径）
const ACCOUNT_MOUNT_MAP = {
  1: '/云盘/cmcc/我的移动云盘',   // 移动云盘
  2: '/云盘/pan115/我的115',      // 115 云盘
};

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

    // 情况2：分离后的人声 .strm 文件 /data/netseparated-strm/{hash}_vocals.strm
    // 网盘对应目录：{mountRoot}/separated/{hash}/
    const strmMatch = song.filepath.match(/\/netseparated-strm\/([a-f0-9]+)_(vocals|accomp)\.strm$/);
    if (strmMatch) {
      const hash = strmMatch[1];
      return mountRoot + '/separated/' + hash;
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
    const rawUrl = j.data.raw_url;
    const lrcContent = await new Promise((resolve, reject) => {
      const u = new URL(rawUrl);
      const req = http.request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'GET',
        timeout: 15000,
      }, (res) => {
        // 跟随重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // 简单处理：返回 null，让后续逻辑处理
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
    });

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
 * 上传逐字歌词到网盘同级目录
 * 返回 true/false
 */
// 支持写入的云盘驱动（139Yun/移动云盘 AList 驱动不支持写入，上传返回 success 但实际无效）
const WRITABLE_DRIVERS = ['pan115', '115', 'quark', 'aliyun', 'baidu', 'xunlei'];

async function uploadLyricsToCloud(song, lrcContent) {
  try {
    const dir = getCloudDirForSong(song);
    if (!dir) {
      console.log('[CloudLyrics] skip upload: no cloud dir for song', song.id);
      return false;
    }

    // 检查云盘驱动是否支持写入（移动云盘 139Yun 不支持）
    const accountId = song.cloud_account_id || 1;
    // 简单判断：路径包含 cmcc/139/移动 的跳过上传
    if (dir.includes('cmcc') || dir.includes('139') || dir.includes('移动')) {
      console.log('[CloudLyrics] skip upload: driver not writable (139Yun/CMCC), dir=', dir);
      return false;
    }

    const token = await getAlistToken();
    const fileName = getLyricsFileName(song);
    const filePath = dir + '/' + fileName;

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
          'File-Path': filePath,
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

module.exports = {
  getAlistToken,
  getCloudDirForSong,
  getLyricsFileName,
  fetchCloudLyrics,
  uploadLyricsToCloud,
};
