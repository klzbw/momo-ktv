// 「网盘/网络挂载曲库本地缓存」
//
// 背景：ffprobe/ffmpeg 直接对着慢速网络挂载(网盘/NAS/云盘类)里的源文件做探测、
// 转码，一旦网络抖动，单个文件的一次读取就可能拖到几十秒——而 scanner.js 的
// probeAudioTracks() 是同步阻塞调用，慢速网络下会把整个 Node 事件循环冻住，
// 直接导致点歌、播放、管理页面全部没反应(详见 scanner.js 顶部注释)。
//
// 这个模块的思路：网络路径下的文件第一次被用到(扫描探测/播放)时，先完整拷贝
// 一份到本地磁盘(/data 下，速度快、稳定)，探测和播放都改成对着这份本地缓存
// 操作，网络挂载本身只在"拷贝"这一步被触碰到，且拷贝走的是 fs 流式复制
// (不是同步整读进内存)，不会长时间占用事件循环。之后同一首歌不管探测多少次、
// 播放多少次，都是纯本地磁盘 IO，速度和可靠性跟本地曲库没有区别。
//
// 设计上特意让"本地缓存路径"和"原始源路径"两者解耦、只通过 songId 关联
// (而不是直接用源文件名/路径推导缓存路径)：这是为以后可能加入的 STRM 导入
// 功能预留的口子——一个 .strm 文件本质上"只是一个指向真实媒体地址的文本文件"，
// 它指向的目标可能是网络路径、也可能是一个 http(s) 直链，两种情况都可以统一
// 归到"这首歌的源不是可以直接稳定快速访问的本地文件，需要先落地缓存"这同一套
// 处理逻辑里——真正要改的只是"怎么从源描述算出实际要读取的字节从哪来"这一步
// (未来是"读 .strm 文件内容拿到目标地址"，现在是"直接就是网络挂载路径")，
// 缓存/探测/播放这一整套下游逻辑完全不用动。见本文件底部 resolveSourceInput()
// 的注释。
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const log = require('./logger');
const db = require('./db');

const CACHE_DIR = process.env.SOURCE_CACHE_DIR || '/data/source-cache';

// 需求(网盘/曲库来源统一放到曲库后台管理)：这三项调优参数原来只能通过改
// docker-compose.yml 里的环境变量 + 重建容器才能调整，现在改成跟
// cacheCleaner.js(HLS 转码缓存清理策略)完全同样的模式——存进数据库
// settings 表，通过「曲库管理」后台的"曲库来源"设置页面读写，改了立刻生效，
// 不需要重建容器。SOURCE_CACHE_MAX_MB/MAX_AGE_DAYS/CONCURRENCY 这三个环境
// 变量仍然读取，但只在数据库里从未保存过对应设置时(全新安装)当默认值使用，
// 一旦管理员在后台保存过一次，后续一律以数据库里的值为准。
const CACHE_MAX_MB_KEY = 'source_cache_max_mb';
const CACHE_MAX_AGE_DAYS_KEY = 'source_cache_max_age_days';
const CACHE_CONCURRENCY_KEY = 'source_cache_concurrency';

const ENV_DEFAULT_MAX_MB = Number(process.env.SOURCE_CACHE_MAX_MB) || 51200; // 50GB
const ENV_DEFAULT_MAX_AGE_DAYS = Number(process.env.SOURCE_CACHE_MAX_AGE_DAYS) || 14;
const ENV_DEFAULT_CONCURRENCY = Math.max(1, Number(process.env.SOURCE_CACHE_CONCURRENCY) || 2);

function getSettingRaw(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSettingRaw(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function getCacheSettings() {
  const maxMbRaw = Number(getSettingRaw(CACHE_MAX_MB_KEY));
  const maxAgeRaw = Number(getSettingRaw(CACHE_MAX_AGE_DAYS_KEY));
  const concurrencyRaw = Number(getSettingRaw(CACHE_CONCURRENCY_KEY));
  return {
    maxMB: Number.isFinite(maxMbRaw) && maxMbRaw > 0 ? maxMbRaw : ENV_DEFAULT_MAX_MB,
    maxAgeDays: Number.isFinite(maxAgeRaw) && maxAgeRaw > 0 ? maxAgeRaw : ENV_DEFAULT_MAX_AGE_DAYS,
    concurrency: Number.isFinite(concurrencyRaw) && concurrencyRaw > 0 ? Math.round(concurrencyRaw) : ENV_DEFAULT_CONCURRENCY,
  };
}

function saveCacheSettings({ maxMB, maxAgeDays, concurrency }) {
  if (Number.isFinite(maxMB) && maxMB > 0) setSettingRaw(CACHE_MAX_MB_KEY, maxMB);
  if (Number.isFinite(maxAgeDays) && maxAgeDays > 0) setSettingRaw(CACHE_MAX_AGE_DAYS_KEY, maxAgeDays);
  if (Number.isFinite(concurrency) && concurrency > 0) setSettingRaw(CACHE_CONCURRENCY_KEY, Math.round(concurrency));
  return getCacheSettings();
}

// 同时最多拷贝几个文件；网盘的瓶颈通常是网络带宽/NAS 并发连接数，拷贝太多个
// 文件一起跑反而互相抢带宽、单个文件拷贝耗时更长。之前是模块加载时算一次的
// 常量，现在改成每次入队时现读一次数据库设置——管理员在后台调整并发数之后，
// 不需要重启应用就能对下一批排队任务生效(已经在跑的任务不受影响，很正常)。

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// songId -> Promise<string 本地缓存路径>，正在进行中的拷贝任务；避免同一首歌
// 被并发的多个请求(比如扫描探测 + 用户恰好点了这首歌)重复触发拷贝。
const inflight = new Map();
// 拷贝队列：超过 CONCURRENCY 的任务先排队，而不是无限制并发拷贝。
const queue = [];
let running = 0;

function cachePathFor(songId, srcPath) {
  // 用源文件的真实后缀名，保证缓存出来的文件 ffprobe/ffmpeg 打开时容器格式
  // 识别不受影响(部分容器格式的探测会参考文件扩展名)。
  // 需求(网盘STRM支持)：srcPath 现在可能是带查询串的 http(s) 直链(比如
  // "https://x.com/movie.mp4?token=xxx&expire=123")，直接 path.extname 会把
  // 查询串一起当成后缀名(".mp4?token=xxx...")，这里先去掉 "?"/"#" 之后的
  // 部分再取扩展名；本地/网络挂载路径没有这两个字符，行为不变。
  const cleanPath = String(srcPath).split(/[?#]/)[0];
  const ext = path.extname(cleanPath) || '.mp4';
  return path.join(CACHE_DIR, `${songId}${ext}`);
}

function tmpPathFor(finalPath) {
  return `${finalPath}.part`;
}

// 判断"本地缓存是否已经是最新的"：源文件的大小 + mtime 都跟上次缓存时记录的
// 一致才算数——网盘上文件被替换成同名新文件是完全可能发生的场景(比如管理员
// 重新上传了一版剪辑过的 MV)，不能只看缓存文件本身存不存在。
// 需求(网盘STRM支持)：srcStat 现在可能来自 http(s) 直链的 HEAD 请求(见
// statRemote())，部分网盘直链不返回 Content-Length/Last-Modified，这种
// 情况下 srcStat.size/mtimeMs 会是 null，没法做强校验——退化成"本地缓存
// 文件还在就信任它"，不重新下载；这是"避免频繁探测网盘"这个目标在缓存
// 校验环节的延伸，宁可少校验一次源是否变化，也不为了校验去反复请求网盘。
function isCacheFresh(songRow, srcStat) {
  if (!songRow || !songRow.cache_path || songRow.cache_status !== 'ready') return false;
  if (!fs.existsSync(songRow.cache_path)) return false;
  if (srcStat.size == null || srcStat.mtimeMs == null) return true;
  try {
    const cacheStat = fs.statSync(songRow.cache_path);
    return (
      songRow.cache_src_size === srcStat.size &&
      songRow.cache_src_mtime === Math.round(srcStat.mtimeMs) &&
      cacheStat.size === srcStat.size
    );
  } catch (e) {
    return false;
  }
}

// 需求(网盘STRM支持)：.strm 文件内容除了"网络挂载路径"，也可能是网盘提供的
// http(s) 直链——这两种源在"要不要走 sourceCache 落地缓存"上结论一样，但
// "怎么读到字节"不一样，这里统一判断+分流，下面 getSourceStat()/copyFile()
// 都依赖这个判断。
function isRemoteUrl(p) {
  return /^https?:\/\//i.test(String(p || ''));
}

// 对 http(s) 直链做一次 HEAD 请求，只为了拿 Content-Length/Last-Modified
// 用于缓存新鲜度校验(isCacheFresh)，不下载正文，开销很小；跟随最多 5 次
// 302/301 重定向(部分网盘直链会重定向到真实存储节点)。拿不到 Content-Length
// 或 Last-Modified 时对应字段返回 null，交给 isCacheFresh 按"信任已有缓存"
// 处理，不在这里报错阻断整个流程。
// 需求修复(自建STRM播放接口用HEAD探测会失败，导致完全无法播放)：不少网盘
// STRM 生成工具(比如把 .strm 内容指向自己搭的一个小型直链/转发服务，形如
// "/api/strm/play/{id}/{hash}/t/{token}/n/{文件名}" 这种自定义路由)只实现了
// GET 这一种方法用来处理真正的播放请求——遇到 HEAD 请求要么直接返回
// 404/405，要么连接层面就拒绝/复位，不会规规矩矩回一个能被上面 statusCode
// 判断接住的 4xx/5xx。这类地址往往在 Emby 里能正常播放，是因为 Emby 的
// 客户端播放器本来就是直接发 GET/Range 请求去拿视频数据，从来不会先发一次
// HEAD 探测——而我们这里为了拿 Content-Length/Last-Modified 判断"要不要
// 重新缓存"，一直用的是 HEAD，遇到这类只认 GET 的接口就会在缓存这一步直接
// 报错，播放请求还没走到"读字节"那一步就已经失败了，跟"能不能软解/硬解"
// 完全无关，因此两种模式会同时失败，正好对应用户反馈的"完全无法播放"。
// 加一道兜底：HEAD 失败(不管是连接错误还是非 200/3xx 状态码)时，退化成
// 发一个只要 1 字节的 Range GET 请求(bytes=0-0)达到同样的"探测但不用真的
// 下载整个文件"的效果——这更贴近播放器的真实请求方式，兼容性明显更好；
// 拿到响应头(Content-Length 或 Content-Range 里的总大小、Last-Modified)后
// 立刻 destroy 掉这个连接，不会真的多下载数据。
// 另外统一加一个看起来像正常播放器/浏览器的 User-Agent——部分自建直链服务
// 会用 UA 做简单的防盗链/风控，Node 默认请求不带 UA(或者带着一望而知是脚本
// 的 UA)时可能被直接拒绝，Emby 自己发请求时是带着"Emby"相关 UA 的。这里用
// 一个通用的浏览器 UA，覆盖面比自称"MomoKTV/xxx"这种一看就是自定义客户端
// 的标识更广，不容易被专门针对陌生 UA 的规则拦下来。
const REMOTE_REQUEST_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function statRemote(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, { method: 'HEAD', timeout: 15000, headers: { 'User-Agent': REMOTE_REQUEST_UA } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        statRemote(res.headers.location, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        // 不直接 reject：HEAD 拿到了明确的非 200 状态码，可能是这个接口压根
        // 不支持 HEAD(常见做法是对不认识的方法回 404/405)，不代表源真的不可
        // 访问，退化到下面的 Range GET 再确认一次。
        statRemoteViaRangeGet(url, redirectsLeft).then(resolve, reject);
        return;
      }
      const lenHeader = res.headers['content-length'];
      const size = lenHeader != null ? Number(lenHeader) : NaN;
      const lastModified = res.headers['last-modified'];
      const mtimeMs = lastModified ? new Date(lastModified).getTime() : NaN;
      res.resume();
      resolve({
        size: Number.isFinite(size) ? size : null,
        mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : null,
      });
    });
    req.on('timeout', () => req.destroy(new Error('HEAD 请求超时')));
    // 需求修复(自建STRM播放接口用HEAD探测会失败)：这里的 error 通常是连接被
    // 直接拒绝/复位(比如服务端压根没实现处理 HEAD 方法的代码路径)，同样退化
    // 到 Range GET，而不是直接判定"源不可访问"。
    req.on('error', () => {
      statRemoteViaRangeGet(url, redirectsLeft).then(resolve, reject);
    });
    req.end();
  });
}

// HEAD 探测失败时的退路：发一个 Range: bytes=0-0 的 GET 请求，只要一拿到
// 响应头就立刻销毁连接，不等 body 传完——效果上跟 HEAD 一样轻量，但用的是
// 播放器真正会用的方法(GET)，兼容性覆盖面更大。响应头里没有 Content-Range/
// Content-Length(比如服务端压根不支持 Range，直接把整个文件当 200 甩过来)
// 时退化成信任"能成功建立连接、拿到 2xx 状态码"这件事本身，size/mtimeMs
// 给 null——isCacheFresh() 已经把这种情况当"信任已有缓存、不重新下载"处理，
// 不会因为拿不到这两个值就播放失败。
function statRemoteViaRangeGet(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, { method: 'GET', timeout: 15000, headers: { 'User-Agent': REMOTE_REQUEST_UA, Range: 'bytes=0-0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        statRemoteViaRangeGet(res.headers.location, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.destroy();
        reject(new Error(`探测请求返回状态码 ${res.statusCode}`));
        return;
      }
      let size = null;
      const contentRange = res.headers['content-range']; // 形如 "bytes 0-0/12345678"
      if (contentRange) {
        const m = /\/(\d+)\s*$/.exec(contentRange);
        if (m) size = Number(m[1]);
      }
      if (size == null) {
        const lenHeader = res.headers['content-length'];
        // 服务端如果不支持 Range、直接把整个文件当 200 全量返回，
        // content-length 反映的就是真实文件大小，可以直接采信；如果服务端
        // 老老实实回了 206 却没给 content-range(理论上不太可能，兜底一下)，
        // content-length 在 206 场景下只代表这一小段(1字节)的长度，不能当
        // 文件总大小用，这种情况宁可 size 为 null，也不要写一个错误的"1"。
        if (res.statusCode === 200 && lenHeader != null) size = Number(lenHeader);
      }
      const lastModified = res.headers['last-modified'];
      const mtimeMs = lastModified ? new Date(lastModified).getTime() : NaN;
      res.destroy(); // 拿到需要的响应头就够了，不用等 body(哪怕只有1字节)传完，也不需要真的读取
      resolve({
        size: Number.isFinite(size) ? size : null,
        mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : null,
      });
    });
    req.on('timeout', () => req.destroy(new Error('探测请求超时')));
    req.on('error', reject);
    req.end();
  });
}

// 统一入口：本地/网络挂载路径直接 fs.statSync；http(s) 直链走 statRemote()。
// 返回值统一成 { size, mtimeMs } 这个形状，供 isCacheFresh() 和写库时使用，
// 调用方(ensureCached)不需要关心源到底是哪一种。
async function getSourceStat(srcPath) {
  if (isRemoteUrl(srcPath)) return statRemote(srcPath);
  const st = fs.statSync(srcPath); // 本地路径读不到直接抛错，交给调用方按"源不可访问"处理
  return { size: st.size, mtimeMs: st.mtimeMs };
}

function updateCacheRow(songId, fields) {
  const cols = Object.keys(fields);
  if (cols.length === 0) return;
  const setClause = cols.map(c => `${c} = @${c}`).join(', ');
  db.prepare(`UPDATE songs SET ${setClause} WHERE id = @id`).run({ ...fields, id: songId });
}

// 需求(MV加载动画下方显示下载速度/预计等待时长)：网盘/网络挂载曲目播放前的
// "加载中"转圈，实际大头就是耗在这里——把源文件从网络拷到本地缓存这一步。
// 以前这一步对前端完全是黑盒，网速慢的时候用户只能对着转圈干等，猜不到还要
// 等多久，容易误以为卡死了。这里维护一份内存态的实时进度表(songId -> 进度)，
// 只在"正在拷贝"期间存在，拷贝成功/失败都会清掉；不落库、不持久化——这本来
// 就是转瞬即逝的过程量，重启进程后这一份缓存拷贝要么已经完成、要么会重新
// 触发拷贝，不需要跨进程保留这份中间状态。
// speedBps 用简单的指数移动平均而不是"总字节数/总耗时"，是为了让显示的
// 速度能反映"最近"的网速，而不是被开头一段(可能因为TCP慢启动、或者网盘\n// 偶尔抖动)拖累的历史平均值——网速忽快忽慢时，指数移动平均能更快跟上变化，\n// 预计剩余时间也会更准。
const cacheProgress = new Map(); // songId -> { totalBytes, bytesCopied, speedBps, startedAt, updatedAt }

// 真正执行一次拷贝：流式读写，不会把整个文件读进内存；写到 .part 临时文件，
// 成功后原子 rename 成最终文件名——避免"拷贝到一半服务重启/进程崩溃"留下的
// 半成品文件被后续逻辑误当成"已经缓存完成"。resolve 值是这次拷贝时顺带拿到
// 的源 stat（{size, mtimeMs}，可能为 null），调用方用它写 cache_src_size/
// cache_src_mtime，不需要再额外发一次探测请求去问"这个源多大"。
//
// 需求修复(自建STRM播放接口只支持一次性/限次访问的直链，被单独探测一次就
// 可能失效)：本地/网络挂载路径这边行为不变，先 fs.statSync 拿 size/mtime
// 再流式拷贝；http(s) 直链这边不再依赖调用方预先探测好的 totalBytes——直接
// 在这里自己发起 GET，从这一次连接的响应头里拿 Content-Length/Last-Modified
// 当作 stat，再把响应体接着 pipe 进目标文件。全程对源地址只发一次 HTTP
// 请求，跟真正播放器"拿到地址直接整段读完"的行为完全一致，不会因为"先探测
// 一次、根据探测结果再决定要不要下载"这种额外往返，把只允许访问一次/限次
// 访问的直链在探测阶段就提前消耗掉。
// opts.songId 可选：传入时会维护 cacheProgress 里对应的实时进度条目，供
// getCacheProgress() 查询；不传则完全不影响拷贝行为，只是不会有进度可查。
function copyFile(srcPath, destPath, opts = {}) {
  const { songId } = opts;
  return new Promise((resolve, reject) => {
    const tmp = tmpPathFor(destPath);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    let settled = false;
    let progress = null;
    let bytesCopied = 0;
    let lastTickAt = Date.now();
    let lastTickBytes = 0;

    const writeStream = fs.createWriteStream(tmp);

    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (songId != null) cacheProgress.delete(songId);
      writeStream.destroy();
      fs.rm(tmp, { force: true }, () => {});
      reject(err);
    };
    writeStream.on('error', fail);

    const startProgress = (totalBytes) => {
      if (songId == null) return;
      progress = { totalBytes: Number.isFinite(totalBytes) ? totalBytes : null, bytesCopied: 0, speedBps: 0, startedAt: Date.now(), updatedAt: Date.now() };
      cacheProgress.set(songId, progress);
    };
    const trackChunk = (chunk) => {
      if (!progress) return;
      bytesCopied += chunk.length;
      const now = Date.now();
      const dt = now - lastTickAt;
      // 每 500ms 才重新算一次速度，避免 data 事件触发太密时把瞬时抖动
      // (单个 chunk 特别大/特别小)直接当成"当前网速"展示，跳动太厉害。
      if (dt >= 500) {
        const instSpeed = ((bytesCopied - lastTickBytes) / dt) * 1000;
        progress.speedBps = progress.speedBps > 0 ? progress.speedBps * 0.4 + instSpeed * 0.6 : instSpeed;
        lastTickAt = now;
        lastTickBytes = bytesCopied;
      }
      progress.bytesCopied = bytesCopied;
      progress.updatedAt = now;
    };
    const finish = (stat) => {
      if (settled) return;
      settled = true;
      if (songId != null) cacheProgress.delete(songId);
      fs.rename(tmp, destPath, (err) => {
        if (err) return reject(err);
        resolve(stat);
      });
    };

    if (!isRemoteUrl(srcPath)) {
      let st;
      try {
        st = fs.statSync(srcPath);
      } catch (e) {
        fail(e);
        return;
      }
      startProgress(st.size);
      const readStream = fs.createReadStream(srcPath);
      readStream.on('error', fail);
      readStream.on('data', trackChunk);
      readStream.pipe(writeStream);
      writeStream.on('finish', () => finish({ size: st.size, mtimeMs: st.mtimeMs }));
      return;
    }

    const doRequest = (url, redirectsLeft) => {
      const mod = url.startsWith('https') ? https : http;
      const req = mod.get(url, { headers: { 'User-Agent': REMOTE_REQUEST_UA } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          doRequest(res.headers.location, redirectsLeft - 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          fail(new Error(`下载失败，状态码 ${res.statusCode}`));
          return;
        }
        const lenHeader = res.headers['content-length'];
        const size = lenHeader != null ? Number(lenHeader) : NaN;
        const lastModified = res.headers['last-modified'];
        const mtimeMs = lastModified ? new Date(lastModified).getTime() : NaN;
        const finalSize = Number.isFinite(size) ? size : null;
        const finalMtimeMs = Number.isFinite(mtimeMs) ? mtimeMs : null;
        startProgress(finalSize);
        res.on('data', trackChunk);
        res.on('error', fail);
        res.pipe(writeStream);
        writeStream.on('finish', () => finish({ size: finalSize, mtimeMs: finalMtimeMs }));
      });
      req.on('error', fail);
    };
    doRequest(srcPath, 5);
  });
}

// 供前端"加载中"界面查询：这首歌现在是不是正在从网络拷贝到本地缓存，如果
// 是，顺带给出已拷贝字节数/总字节数/预估速度/预计剩余秒数，方便展示"下载
// 速度：3.2MB/s，预计还需 8 秒"这类提示，而不是让用户对着转圈干等、猜不到
// 还要多久。totalBytes 未知(比如 HTTP 直链没有返回 Content-Length)时
// etaSeconds 给 null，前端只展示速度、不展示"还需多久"。
function getCacheProgress(songId) {
  const p = cacheProgress.get(songId);
  if (!p) return { active: false, bytesCopied: null, totalBytes: null, speedBps: 0, etaSeconds: null };
  const speedBps = Math.max(0, Math.round(p.speedBps));
  let etaSeconds = null;
  if (p.totalBytes != null && speedBps > 1024) {
    const remain = Math.max(0, p.totalBytes - p.bytesCopied);
    etaSeconds = Math.round(remain / speedBps);
  }
  return { active: true, bytesCopied: p.bytesCopied, totalBytes: p.totalBytes, speedBps, etaSeconds };
}

function runNext() {
  if (running >= getCacheSettings().concurrency) return;
  const job = queue.shift();
  if (!job) return;
  running++;
  job().finally(() => {
    running--;
    runNext();
  });
}

function enqueue(job) {
  return new Promise((resolve, reject) => {
    queue.push(() => job().then(resolve, reject));
    runNext();
  });
}

// 对外主入口：确保 songId 这首歌在本地有一份新鲜的缓存，返回本地缓存文件的
// 绝对路径。srcPath 是当前判断出的真实源地址(见 resolveSourceInput 的注释，
// 现阶段就是网络挂载下的文件路径)。已经有新鲜缓存时直接返回，不重复拷贝；
// 缓存过期(源文件变了)会重新拷贝一份覆盖。
//
// 注意：这个函数在"还没缓存完成"时会一直等到拷贝完成才 resolve——调用方
// (scanner.js 的探测、hlsgen.js 的转码)本来就是"这首歌现在要用，等它准备好"
// 的场景，愿意等是合理的；如果不想等(比如只是想知道"现在能不能立刻播放")，
// 应该用 getReadyPathOrNull() 查询当前状态，不要调用这个函数。
async function ensureCached(songId, srcPath) {
  if (inflight.has(songId)) return inflight.get(songId);

  const p = (async () => {
    const row = db.prepare('SELECT cache_path, cache_status, cache_src_size, cache_src_mtime FROM songs WHERE id = ?').get(songId);
    const hasExistingCache = !!(row && row.cache_status === 'ready' && row.cache_path && fs.existsSync(row.cache_path));

    // 需求修复(自建STRM播放接口只支持一次性/限次访问的直链，被单独探测一次
    // 就可能失效——用户反馈的"这个 STRM 地址在 Emby 里能播、这里播不了"就是
    // 这一类问题)：只有已经存在一份可用的本地缓存时，才值得先做一次轻量探测
    // (getSourceStat，本地/网络挂载路径是 fs.statSync；http(s) 直链见
    // statRemote())去确认"源有没有变"，探测本身对这类场景不是必须的、只是
    // 锦上添花，失败了就直接信任现有缓存继续播放，不阻断。完全没有缓存(第一
    // 次遇到这首歌)时，不再额外发起这次探测——直接进入下面的下载分支，
    // copyFile() 会自己用同一次下载连接的响应头拿到 stat，全程对源地址只发
    // 一次 HTTP 请求，跟播放器真实播放时的行为一致，不会有"探测请求先把
    // 一次性令牌用掉，真正下载时链接已经失效"这种问题。
    if (hasExistingCache) {
      try {
        const srcStat = await getSourceStat(srcPath);
        if (isCacheFresh(row, srcStat)) return row.cache_path;
      } catch (e) {
        log.warn('SOURCE_CACHE', `[歌曲 id=${songId}] 源探测失败，改为信任已有本地缓存继续播放: ${e.message}`);
        return row.cache_path;
      }
    }

    const destPath = cachePathFor(songId, srcPath);
    updateCacheRow(songId, { cache_status: 'caching' });
    const t0 = Date.now();
    log.info('SOURCE_CACHE', `[歌曲 id=${songId}] 开始从网络路径缓存到本地: ${srcPath}`);
    let stat;
    try {
      stat = await enqueue(() => copyFile(srcPath, destPath, { songId }));
    } catch (e) {
      updateCacheRow(songId, { cache_status: 'failed' });
      log.error('SOURCE_CACHE', `[歌曲 id=${songId}] 缓存失败: ${e.message}`);
      throw new Error(`源文件不可访问(网络挂载可能已断开，或STRM目标直链失效): ${e.message}`);
    }
    updateCacheRow(songId, {
      cache_path: destPath,
      cache_status: 'ready',
      cache_src_size: stat.size,
      // http(s) 直链没有 Last-Modified 时 stat.mtimeMs 是 null，直接存
      // null(而不是 Math.round(null) 得到的 0)——isCacheFresh() 已经把
      // "size/mtimeMs 任一为 null"当成"信任已有缓存"处理，这里存 0 反而会
      // 被后面某次成功拿到真实 mtime 的校验误判成"源文件变了"。
      cache_src_mtime: stat.mtimeMs != null ? Math.round(stat.mtimeMs) : null,
    });
    log.info('SOURCE_CACHE', `[歌曲 id=${songId}] 缓存完成，耗时 ${Date.now() - t0}ms，大小 ${stat.size != null ? (stat.size / 1048576).toFixed(1) + 'MB' : '未知(源未提供Content-Length)'}`);
    return destPath;
  })();

  inflight.set(songId, p);
  try {
    return await p;
  } finally {
    inflight.delete(songId);
  }
}

// 查询当前是否已经有可用的本地缓存，不触发新的拷贝、不等待——供"播放请求
// 到达时，缓存还没准备好该怎么办"这类不想阻塞用户的场景使用：能用就用本地
// 缓存，不能用就临时直接读网络路径(能播但可能卡)，同时后台悄悄触发一次
// ensureCached() 为下一次播放做准备。
function getReadyPathOrNull(songId) {
  const row = db.prepare('SELECT cache_path, cache_status FROM songs WHERE id = ?').get(songId);
  if (row && row.cache_status === 'ready' && row.cache_path && fs.existsSync(row.cache_path)) {
    return row.cache_path;
  }
  return null;
}

// 供 hlsgen.js(转码)/index.js(硬解直连播放)/queuePreload.js(时长预读) 这三处
// "需要立刻知道该读哪个文件、但不愿意等一次完整拷贝"的场景统一调用：
//   - 本地文件(is_network=0)：直接返回原始 filepath，跟这次改动之前完全一样，
//     不引入任何额外开销。
//   - 网络文件已有新鲜本地缓存：返回缓存路径——探测/转码/播放全部走本地
//     磁盘，快且稳定。
//   - 网络文件还没缓存好(第一次遇到/缓存中/上次失败)：返回原始网络路径当
//     兜底，保证"缓存没准备好也还能播、只是可能比较慢/偶尔失败"而不是直接
//     不能用；同时在后台悄悄踢一次 ensureCached()(不等待、不阻塞调用方)，
//     这样下一次同一首歌播放大概率就能命中本地缓存了。传入 onCacheError 可以
//     在后台缓存最终失败时得到通知(可选，目前调用方都没有用到，为将来预留)。
function resolvePlaybackPath(song, onCacheError) {
  // 需求(网盘STRM支持)：STRM 曲目跟网络挂载曲目一样需要走本地缓存，但
  // "没有新鲜缓存时的兜底路径"不能再是原样返回 song.filepath 了——filepath
  // 是那个 .strm 文本文件本身，直接拿去播放/转码没有意义。
  const needsCache = !!(song && (song.is_network || song.is_strm));
  if (!needsCache) return { path: song ? song.filepath : null, cached: true };
  const ready = getReadyPathOrNull(song.id);
  if (ready) return { path: ready, cached: true };
  // 没有现成的新鲜缓存：后台悄悄触发一次缓存，不等待、也不让调用方的这次
  // 请求因为缓存过程而变慢。
  ensureCached(song.id, resolveSourceInput(song.filepath)).catch(e => {
    log.warn('SOURCE_CACHE', `[歌曲 id=${song.id}] 后台补缓存失败: ${e.message}`);
    if (onCacheError) onCacheError(e);
  });
  // 网络挂载曲目的兜底还能"直接读网络路径当场播"、能用但可能卡；STRM 曲目
  // 在第一次缓存完成之前，没有任何"能读的真实媒体路径"可以兜底(filepath
  // 只是文本文件)，只能如实告诉调用方"现在还没准备好"，由调用方决定怎么
  // 处理(比如提示"正在准备中，请稍候")。
  return { path: song.is_strm ? null : song.filepath, cached: false };
}

// ============ 缓存空间清理 ============
// 跟 cacheCleaner.js(HLS 转码产物清理) 是完全独立的两套磁盘占用，各管各的：
// 这里清理的是"网盘源文件的本地缓存副本"，HLS 缓存清的是"转码后的播放分片"。
// 策略比 HLS 缓存简单一些：按"缓存文件的最后访问时间(mtime，每次 ensureCached
// 命中新鲜缓存或重新缓存都会更新)"，超过大小限额或天数限制的最早文件优先清。
function listCacheFiles() {
  if (!fs.existsSync(CACHE_DIR)) return [];
  let entries;
  try {
    entries = fs.readdirSync(CACHE_DIR, { withFileTypes: true });
  } catch (e) {
    log.error('SOURCE_CACHE', `读取缓存目录失败: ${e.message}`);
    return [];
  }
  const files = [];
  for (const ent of entries) {
    if (!ent.isFile() || ent.name.endsWith('.part')) continue; // 跳过还在拷贝中的半成品
    const idMatch = /^(\d+)\./.exec(ent.name);
    if (!idMatch) continue;
    const full = path.join(CACHE_DIR, ent.name);
    try {
      const st = fs.statSync(full);
      files.push({ songId: Number(idMatch[1]), path: full, size: st.size, mtime: st.mtimeMs });
    } catch (e) { /* 忽略单个文件统计失败 */ }
  }
  return files;
}

function removeCacheFile(entry, reason) {
  try {
    fs.rmSync(entry.path, { force: true });
    updateCacheRow(entry.songId, { cache_status: 'none', cache_path: null });
    log.info('SOURCE_CACHE', `[歌曲 id=${entry.songId}] 本地缓存已清理(约 ${(entry.size / 1048576).toFixed(1)}MB)，原因: ${reason}`);
    return true;
  } catch (e) {
    log.error('SOURCE_CACHE', `[歌曲 id=${entry.songId}] 本地缓存清理失败: ${e.message}`);
    return false;
  }
}

// 孤儿缓存：对应歌曲已经不在曲库里(被扫描判定为已删除)的缓存文件，任何时候
// 运行清理都会顺带处理，跟下面的空间/天数策略无关。
function cleanupOrphans(getValidSongIds) {
  let validIds;
  try {
    validIds = new Set((getValidSongIds ? getValidSongIds() : []).map(Number));
  } catch (e) {
    log.warn('SOURCE_CACHE', `获取有效曲目 id 列表失败，本次跳过孤儿缓存清理: ${e.message}`);
    return { removed: 0, freed: 0 };
  }
  let removed = 0, freed = 0;
  for (const f of listCacheFiles()) {
    if (!validIds.has(f.songId)) {
      if (removeCacheFile(f, '对应歌曲已不在曲库中(孤儿缓存)')) { removed++; freed += f.size; }
    }
  }
  return { removed, freed };
}

function cleanupBySize(limitMB) {
  const limitBytes = limitMB * 1024 * 1024;
  const files = listCacheFiles().sort((a, b) => a.mtime - b.mtime);
  let total = files.reduce((s, f) => s + f.size, 0);
  const totalBefore = total;
  let removed = 0, freed = 0;
  for (const f of files) {
    if (total <= limitBytes) break;
    if (removeCacheFile(f, `本地缓存总量(约${(totalBefore / 1048576).toFixed(0)}MB)超出限额 ${limitMB}MB`)) {
      total -= f.size; freed += f.size; removed++;
    }
  }
  return { removed, freed, totalBefore, totalAfter: total };
}

function cleanupByAge(days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0, freed = 0;
  for (const f of listCacheFiles()) {
    if (f.mtime < cutoff) {
      if (removeCacheFile(f, `超过 ${days} 天未被访问`)) { removed++; freed += f.size; }
    }
  }
  return { removed, freed };
}

function runCleanup(getValidSongIds, opts = {}) {
  const settings = getCacheSettings();
  const maxMB = Number.isFinite(opts.maxMB) && opts.maxMB > 0 ? opts.maxMB : settings.maxMB;
  const maxAgeDays = Number.isFinite(opts.maxAgeDays) && opts.maxAgeDays > 0 ? opts.maxAgeDays : settings.maxAgeDays;
  const orphan = cleanupOrphans(getValidSongIds);
  const bySize = cleanupBySize(maxMB);
  const byAge = cleanupByAge(maxAgeDays);
  return { orphan, bySize, byAge };
}

function getStats() {
  const files = listCacheFiles();
  return { count: files.length, totalSize: files.reduce((s, f) => s + f.size, 0), dir: CACHE_DIR };
}

// ============ 为以后 STRM 导入预留的口子 ============
// 现阶段"一首歌的源"就是扫描时发现的文件路径本身；以后如果加入 STRM 导入，
// 一个 .strm 文件的"源"应该是它文件内容里写的那个目标地址(可能是另一个网络
// 路径，也可能是 http(s) 直链)，而不是 .strm 文件自己那几十字节的文本。
// 这个函数是唯一一处"从数据库里的 filepath 字段算出真正应该读取的源地址"的
// 逻辑，之后只需要在这里加一个分支(判断扩展名是 .strm 就读取文件内容当成
// 目标地址返回)，scanner.js/hlsgen.js/index.js 调用方完全不需要改动。
function resolveSourceInput(filepath) {
  if (String(filepath).toLowerCase().endsWith('.strm')) {
    // .strm 文件本身只是本地磁盘上几十字节的文本文件，读它完全不涉及网盘 IO；
    // 内容 trim 之后就是真正的源地址——可能是另一个网络挂载路径，也可能是
    // http(s) 直链，两种下游(getSourceStat/copyFile)都已经能处理，这里
    // 不用关心目标具体是哪一种。
    // 读取失败(文件被删/权限问题)直接抛出，调用方(resolveProbePath/
    // sourceCache.ensureCached 的调用方)按"这一首处理失败，跳过不影响其它
    // 曲目"的既定原则处理。
    const content = fs.readFileSync(filepath, 'utf8').trim();
    if (!content) throw new Error('STRM 文件内容为空');
    return content;
  }
  return filepath;
}

module.exports = {
  CACHE_DIR,
  ensureCached,
  getReadyPathOrNull,
  resolvePlaybackPath,
  isCacheFresh,
  isRemoteUrl,
  resolveSourceInput,
  // 需求(问题3修复)：scanner.js 每次扫描对"已确认失败过一次"的网盘/STRM
  // 曲目做一次轻量复核(只 stat/HEAD，不下载正文)，判断源是真的丢了还是
  // 只是网络抖动，导出这个函数供其调用。
  getSourceStat,
  getCacheProgress,
  runCleanup,
  cleanupOrphans,
  cleanupBySize,
  cleanupByAge,
  getStats,
  getCacheSettings,
  saveCacheSettings,
};
