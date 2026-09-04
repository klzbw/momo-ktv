const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { WebSocketServer } = require('ws');
const db = require('./db');
const { scanLibrary, syncSongArtists, ensureProbedOnDemand, deleteSongCascade, isProblemAudioCodec, isProblemVideoCodec, getMVDir, getMVRoots, getLibraryRoots, saveLibraryRoots, resolveLibraryRootPath, BASE_MOUNTS } = require('./scanner');
const { ensureHLS, removeHLS, outDir, waitForFile, onBuildComplete } = require('./hlsgen');
const sourceCache = require('./sourceCache');
const { schedulePreload, setPreloadUpdateNotifier, setDecodeMode } = require('./queuePreload');
const cacheCleaner = require('./cacheCleaner');
const lyricsMod = require('./lyrics');
const sepMod = require('./separate');
const cloudDrive = require('./cloud-drive');
const netktvTest = require('./netktv-test');
const netktvScan = require('./netktv-scan');
const netktvMkvScan = require('./netktv-mkv-scan');
const catalog = require('./catalog');
const multer = require('multer');
// 分离产物单首几十 MB，用内存存储收完即落盘到 /data/separated（一首一首传，内存可控）
const sepUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 * 1024, files: 4 } });
const log = require('./logger');

// ---------- 进程级兜底：单个后台任务的意外错误不该拖垮整个服务 ----------
// Bug修复("容器无限重启")的教训：ensureHLS() 后台转码那条 Promise 链之前
// 存在一个"没人消费"的 rejected Promise，Node 遇到 unhandledRejection 默认
// 直接终止整个进程；容器 restart:unless-stopped 又会把它拉起来，队列里那首
// 失败的歌立刻再次触发同样的失败——无限重启死循环。那处具体的坑本身已经
// 修掉了，但这里再加一层进程级兜底：万一以后别的地方（转码、扫描、缓存
// 清理等任何后台异步任务）也不小心留了类似没人 catch 的 rejected Promise，
// 或者抛出了同步的未捕获异常，只记日志、不让它有机会终止整个进程——毕竟
// 这是一个要顶着播放、点歌、曲库管理一起跑的长期服务进程，因为某一首歌
// 转码失败（尤其网盘/网络挂载曲库场景下，源文件偶发访问不到本就是会发生
// 的正常情况）就把整个服务拖下水重启，代价远大于"打个错误日志、这一次
// 操作失败、其它功能继续正常"。
process.on('unhandledRejection', (reason) => {
  log.error('PROCESS', `捕获到未处理的 Promise rejection(已阻止进程崩溃，但说明代码里有类似 ensureHLS 那次的坑，需要找时间补上对应的 .catch)：${reason && reason.stack ? reason.stack : reason}`);
});
process.on('uncaughtException', (err) => {
  log.error('PROCESS', `捕获到未处理的同步异常(已阻止进程崩溃，同样需要找时间定位根因)：${err && err.stack ? err.stack : err}`);
});

// 需求：设置面板(TV端)、导航页、曲库管理后台都要显示当前版本号。版本号只在
// 这一处定义(取自 package.json 的 version 字段，跟 fnOS 应用包 manifest 里
// 的 version 保持同步维护)，通过 /api/stats 接口下发给三个前端页面，不在
// 每个页面各自硬编码一份、以后升级容易漏改。
const APP_VERSION = require('./package.json').version;

const PORT = process.env.PORT || 8080;
const app = express();
app.use(express.json());

// 网盘曲库集成模块
app.use('/api/cloud', cloudDrive.init(db));

// 网络KTV模块（支持 cloud-drive 302 直链 + 挂载路径回退）
const netktvRouter = netktvTest.init({
  cloudDrive: cloudDrive,
  accountId: parseInt(process.env.NETKTV_CLOUD_ACCOUNT_ID || '2', 10),
  basePath: process.env.NETKTV_CLOUD_BASE_PATH || '/momo-ktv/separated',
});
app.use('/api/netktv', netktvRouter);

// 网络KTV扫描模块（扫描115分离文件，生成STRM并入库）
app.use('/api/netktv', netktvScan.init(db, cloudDrive));

// 网络KTV MKV视频扫描模块（扫描115网盘MKV视频，生成STRM并入库）
app.use('/api/netktv', netktvMkvScan.init(db, cloudDrive));

// ---------- 「管理后台」管理员登录 ----------
// 需求变更：管理员密码不再由用户首次打开「管理后台」(/admin) 时自己设置、
// 存进 SQLite，而是改成在 docker-compose.yml 的 environment 里用
// ADMIN_PASSWORD 定义——运维在部署这一步就把密码定下来，跟数据库解耦，
// 换库/重建容器都不用担心"密码丢了"，也不需要再走一遍"首次设置密码"的
// 引导流程。没有在 compose 里配置 ADMIN_PASSWORD 时，回退到一个固定的
// 默认密码，保证老用户直接升级镜像也能照常登录，但每次启动都会打一条
// 醒目的警告日志，提醒尽快在 compose 里设置成自己的密码。
// 注意：登录状态只用来保护「管理后台」页面里真正的管理操作（编辑/删除
// 歌曲、用户管理等）；/api/scan、/api/songs 等电视端、手机点歌页面同样在用
// 的公共接口不受影响——电视端"扫描曲库"本来就需要有人在电视旁边用遥控器
// 操作，风险和管理后台网页端裸露在局域网里不是一回事。
const DEFAULT_ADMIN_PASSWORD = 'admin888';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
if (!process.env.ADMIN_PASSWORD) {
  log.warn('ADMIN', `未在 docker-compose 中设置 ADMIN_PASSWORD 环境变量，当前使用默认管理员密码「${DEFAULT_ADMIN_PASSWORD}」，强烈建议尽快在 compose 里设置成自己的密码并重建容器`);
}
const ADMIN_SESSION_COOKIE = 'ktv_admin_session';
const adminSessions = new Set();

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function hashesMatch(a, b) {
  const bufA = Buffer.from(String(a || '').padEnd(64, '0'));
  const bufB = Buffer.from(String(b || '').padEnd(64, '0'));
  return String(a).length === 64 && crypto.timingSafeEqual(bufA, bufB);
}

// 没有引入 cookie-parser，手动解析 Cookie 请求头即可，避免多引入一个依赖。
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function isAdminAuthed(req) {
  const token = parseCookies(req)[ADMIN_SESSION_COOKIE];
  return !!(token && adminSessions.has(token));
}

function requireAdminAuth(req, res, next) {
  if (isAdminAuthed(req)) return next();
  res.status(401).json({ error: '请先登录管理员账号' });
}

function startAdminSession(res) {
  const token = crypto.randomBytes(24).toString('hex');
  adminSessions.add(token);
  res.cookie(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

app.get('/api/admin/session', (req, res) => {
  res.json({ authed: isAdminAuthed(req) });
});

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  const inputHash = password ? sha256Hex(password) : '';
  if (!hashesMatch(inputHash, sha256Hex(ADMIN_PASSWORD))) {
    log.warn('ADMIN', '管理后台登录失败：密码错误');
    return res.status(401).json({ error: '密码错误' });
  }
  startAdminSession(res);
  log.info('ADMIN', '管理后台登录成功');
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  const token = parseCookies(req)[ADMIN_SESSION_COOKIE];
  if (token) adminSessions.delete(token);
  res.clearCookie(ADMIN_SESSION_COOKIE);
  res.json({ ok: true });
});

// ---------- 「K歌主页面」(TV大屏 /tv、/tv/clean.html) 登录 ----------
// 需求：以前 TV 大屏页面打开即用，谁都能打开局域网地址直接看/操作；现在
// 改成需要账号密码登录才能进入，账号在「管理后台 · 用户管理」里由管理员
// 创建(见下方 /api/admin/tv-users)，跟「管理后台」自己的 ADMIN_PASSWORD
// 是完全独立的两套身份——一个管的是"能不能进管理后台改配置"，一个管的是
// "能不能打开K歌大屏点歌唱歌"。
//
// 会话实现特意不跟管理后台一样用"内存 Set 存 token"：TV 大屏经常是常年
// 开机、容器隔三差五会重启(镜像升级/宿主机重启)，如果登录状态跟着进程
// 内存走，每次重启都要有人拿着遥控器重新登录一次，体验很差，也是"记住
// 登录"这个需求本身的意义所在。改成签发一个自包含的签名 token(类似轻量版
// JWT)：payload 里带用户名、过期时间戳、以及当前密码哈希的短指纹，用
// HMAC-SHA256 签名，密钥是启动时生成一次并持久化到 settings 表的随机串
// (session_secret，见下方)，不随进程重启失效，只要 token 没过期、对应的
// 用户名和密码指纹在 tv_users 表里还对得上，就认为登录有效——这样删除
// 账号、或者管理员帮用户重置了密码，旧 token 会自然失效，不需要额外维护
// 一张"已吊销"名单。
const TV_SESSION_COOKIE = 'ktv_tv_session';
const TV_SESSION_SECRET_KEY = 'session_secret';
const TV_SESSION_REMEMBER_MS = 30 * 24 * 60 * 60 * 1000; // "记住我"：30 天
const TV_SESSION_DEFAULT_MS = 12 * 60 * 60 * 1000;       // 不勾选"记住我"：12 小时

function getSessionSecret() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(TV_SESSION_SECRET_KEY);
  if (row && row.value) return row.value;
  const secret = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(TV_SESSION_SECRET_KEY, secret);
  return secret;
}
const SESSION_SECRET = getSessionSecret();

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function signTvToken(username, ttlMs) {
  const user = db.prepare('SELECT password_hash FROM tv_users WHERE username = ?').get(username);
  if (!user) return null;
  const payload = { u: username, exp: Date.now() + ttlMs, pv: user.password_hash.slice(0, 8) };
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('hex');
  return `${payloadB64}.${sig}`;
}

function verifyTvToken(token) {
  if (!token || token.indexOf('.') === -1) return null;
  const [payloadB64, sig] = token.split('.');
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('hex');
  if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
    return null;
  }
  let payload;
  try { payload = JSON.parse(base64urlDecode(payloadB64).toString('utf8')); } catch (e) { return null; }
  if (!payload || !payload.u || !payload.exp || Date.now() > payload.exp) return null;
  const user = db.prepare('SELECT password_hash FROM tv_users WHERE username = ?').get(payload.u);
  if (!user || user.password_hash.slice(0, 8) !== payload.pv) return null; // 账号已删除或密码已改，旧token失效
  return payload.u;
}

function isTvAuthed(req) {
  const token = parseCookies(req)[TV_SESSION_COOKIE];
  return !!verifyTvToken(token);
}

function startTvSession(res, username, remember) {
  const ttl = remember ? TV_SESSION_REMEMBER_MS : TV_SESSION_DEFAULT_MS;
  const token = signTvToken(username, ttl);
  res.cookie(TV_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // 不勾选"记住我"时不设置 maxAge：浏览器关闭即清掉这个 cookie，跟
    // token 自身 12 小时过期时间是两道独立的保险，任一个先到都会要求
    // 重新登录。
    maxAge: remember ? TV_SESSION_REMEMBER_MS : undefined,
  });
}

app.get('/api/tv-auth/session', (req, res) => {
  const username = (() => {
    const token = parseCookies(req)[TV_SESSION_COOKIE];
    return verifyTvToken(token);
  })();
  const hasUsers = db.prepare('SELECT COUNT(*) c FROM tv_users').get().c > 0;
  res.json({ authed: !!username, username: username || null, hasUsers });
});

app.post('/api/tv-auth/login', (req, res) => {
  const { username, password, remember } = req.body || {};
  const row = username ? db.prepare('SELECT * FROM tv_users WHERE username = ?').get(String(username).trim()) : null;
  const inputHash = password ? sha256Hex(password) : '';
  if (!row || !hashesMatch(inputHash, row.password_hash)) {
    log.warn('TV_AUTH', `K歌主页面登录失败：账号或密码错误(账号="${username || ''}")`);
    return res.status(401).json({ error: '账号或密码错误' });
  }
  startTvSession(res, row.username, !!remember);
  log.info('TV_AUTH', `K歌主页面登录成功：账号="${row.username}"${remember ? '(已记住登录)' : ''}`);
  res.json({ ok: true });
});

app.post('/api/tv-auth/logout', (req, res) => {
  res.clearCookie(TV_SESSION_COOKIE);
  res.json({ ok: true });
});

// ---------- 管理后台 · 用户管理(K歌主页面登录账号) ----------
app.get('/api/admin/tv-users', requireAdminAuth, (req, res) => {
  const users = db.prepare('SELECT id, username, created_at FROM tv_users ORDER BY id ASC').all();
  res.json({ ok: true, users });
});

app.post('/api/admin/tv-users', requireAdminAuth, (req, res) => {
  const { username, password } = req.body || {};
  const name = username ? String(username).trim() : '';
  if (!name) return res.status(400).json({ error: '请输入账号名' });
  if (!password || password.length < 4) return res.status(400).json({ error: '密码至少 4 位' });
  const exists = db.prepare('SELECT id FROM tv_users WHERE username = ?').get(name);
  if (exists) return res.status(409).json({ error: '该账号名已存在' });
  db.prepare('INSERT INTO tv_users (username, password_hash) VALUES (?, ?)').run(name, sha256Hex(password));
  log.info('ADMIN', `用户管理: 新增K歌主页面登录账号「${name}」`);
  res.json({ ok: true });
});

// 重置某个账号的密码。改用户名容易跟"删了重建"混淆、意义也不大，这里只
// 支持改密码，改用户名的场景直接删掉旧账号、新增一个新的即可。
app.put('/api/admin/tv-users/:id', requireAdminAuth, (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 4) return res.status(400).json({ error: '密码至少 4 位' });
  const row = db.prepare('SELECT * FROM tv_users WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '账号不存在' });
  db.prepare('UPDATE tv_users SET password_hash = ? WHERE id = ?').run(sha256Hex(password), row.id);
  log.info('ADMIN', `用户管理: 已重置账号「${row.username}」的密码(该账号此前已登录的浏览器会在下次校验时自动要求重新登录)`);
  res.json({ ok: true });
});

app.delete('/api/admin/tv-users/:id', requireAdminAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM tv_users WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '账号不存在' });
  db.prepare('DELETE FROM tv_users WHERE id = ?').run(row.id);
  log.info('ADMIN', `用户管理: 已删除K歌主页面登录账号「${row.username}」`);
  res.json({ ok: true });
});

// K歌主页面(/tv、/tv/clean.html)登录门禁：未登录时不下发真实页面内容，
// 改成重定向到登录页；登录页本身、以及 /tv 目录下的图片/字体等静态资源
// 不受影响(下面这段只拦截"页面本身"这几个具体路径，其它路径原样放行给
// 后面的 express.static 处理)。用 302 重定向而不是直接在这里 res.send
// 登录页 HTML，是为了让浏览器地址栏、以及登录成功后"回跳到刚才想看的
// 页面"这件事都能用标准的 URL 跳转完成，不需要额外写一套前端路由逻辑。
app.get(['/tv', '/tv/', '/tv/index.html', '/tv/clean.html'], (req, res, next) => {
  if (isTvAuthed(req)) return next();
  const to = req.path === '/tv' || req.path === '/tv/' ? '/tv/index.html' : req.path;
  res.redirect(`/tv/login.html?to=${encodeURIComponent(to)}`);
});

// ---------- 静态资源 ----------
// 根路径 "/" 现在是一个导航首页（墨墨爱K歌品牌页 + 粒子动画背景），提供到
// TV 播放端、曲库管理后台、手机遥控三个入口的链接，方便直接打开
// http://<NAS-IP>:8083 就能跳转到想用的功能，不用记具体子路径。
// express.static 只在请求路径命中 web/home 目录下的真实文件时才会处理
// （比如 "/" 命中 index.html），其它路径（如 /api/xxx、/tv、/admin）会
// 自动 next() 交给下面对应的路由处理，不会互相冲突。
app.use('/',      express.static(path.join(__dirname, '../web/home')));
app.use('/tv',    express.static(path.join(__dirname, '../web/tv')));
app.use('/m',     express.static(path.join(__dirname, '../web/mobile')));
// /mobile 是 /m 的别名，两个路径指向同一份手机点歌页面，纯粹是因为
// "/mobile" 更直观、容易记，"/m" 更短、原来的二维码/收藏链接可能已经在用，
// 两个都留着，不强制迁移。
app.use('/mobile', express.static(path.join(__dirname, '../web/mobile')));
app.use('/admin', express.static(path.join(__dirname, '../web/admin')));
app.use('/mic',   express.static(path.join(__dirname, '../web/mic')));
// 氛围音效(掌声/干杯/喝彩/倒彩)静态目录：网页 <audio> 与 tvOS AVAudioPlayer 都从这里取
app.use('/sounds',express.static(path.join(__dirname, '../web/sounds')));
// 客户端安装包内置下载（Apple TV/iPad 的 IPA、安卓电视的 APK）。飞牛一键包装完后，
// 电视/手机/平板访问 http://NAS_IP:8083/clients 即可直接下载，不用再去 GitHub 找。
app.use('/clients', express.static(path.join(__dirname, '../web/clients')));
app.use('/cover', express.static('/data/covers'));
// 用户上传的动态背景图片（网页遥控端上传、纯音频歌"我的图片"背景模式随机轮播）
app.use('/bg-images', express.static(path.join(process.env.DATA_DIR || '/data', 'backgrounds')));

// ---------- HLS 播放 (音轨切换不中断播放、进度可寻址) ----------
// 取代了旧的"?track=0/1 现场 ffmpeg 重新封装"方案：那个方案吐出的新流没有
// Content-Length/Range 支持，所以切音轨、以及切完音轨后拖进度条，都只能从
// 头播放。现在把视频轨和每条音频轨分别切成独立的 HLS 分片(.ts)，用一份
// master.m3u8 通过 EXT-X-MEDIA 把所有音频轨声明成同一个 AUDIO group。前端
// hls.js 加载它后，切音轨只是 hls.audioTrack = 0/1，只重新拉音频分片，视频
// 播放位置、连续性完全不受影响；HLS 分片本身天然可寻址，拖进度条对任意音轨
// 都正常工作。单音轨文件走同一套逻辑，master.m3u8 里只声明 1 条音频轨即可，
// 具体生成逻辑见 hlsgen.js。
// 渐进式：ensureHLS 不会等整首歌转码完成才 resolve —— 如果这首歌还没转过，
// 它会立刻创建输出目录、把 master.m3u8 写出来，然后把真正耗时的 ffmpeg 转码
// 丢到后台异步执行，函数本身几乎立即返回。所以这个路由的响应时间只取决于
// "有没有查到歌"和"磁盘 IO"，跟这首歌要转多久没有关系，不会再出现点歌后
// 卡在这一步转圈的情况。
app.get('/hls/:id/master.m3u8', async (req, res) => {
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(req.params.id);
  if (!song || !fs.existsSync(song.filepath)) return res.status(404).end();
  log.info('HLS', `请求播放 master.m3u8: id=${song.id} "${song.title || song.filename}"`);
  try {
    // Bug修复(双音轨被误判成单音轨的竞态)：点歌加入队列触发的音轨探测是
    // 异步、不等待的(见 POST /api/queue)，如果这个请求跑得比探测还快，
    // song.audio_tracks 这时还是 null，下面 ensureHLS() 会把它当单音轨处理，
    // 而且这次转码结果一旦生成就不会因为探测结果稍后落地而重做，这次播放
    // 会话会一直停在错误的虚拟声道分离上。这里在真正触发转码之前，只要是
    // STRM/网络挂载曲目且还没探测过，先老老实实 await 一次探测完成——
    // 已经探测过的歌(audio_tracks != null)完全不受影响，不会多等这一下。
    if (song.audio_tracks == null && (song.is_network || song.is_strm)) {
      song.audio_tracks = await ensureProbedOnDemand(song);
    }
    const m3u8Path = await ensureHLS(song);
    res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
    // 原生HLS兼容(iPad iOS12/tvOS 等无 MSE、用不了 hls.js 的端)：它们无法用 JS 切换
    // EXT-X-MEDIA 音轨。带 ?voice=N 时只保留第 N 条音轨并设为默认，前端通过更换
    // video.src 到 master?voice=N 并断点续播来实现原唱/伴奏切换。hls.js(MSE)端不带此参数。
    const voiceIdx = Number.parseInt(req.query.voice, 10);
    if (Number.isInteger(voiceIdx) && voiceIdx >= 0) {
      const srcLines = fs.readFileSync(m3u8Path, 'utf8').split('\n');
      const mediaPos = [];
      srcLines.forEach((ln, i) => { if (ln.indexOf('#EXT-X-MEDIA:') === 0) mediaPos.push(i); });
      if (voiceIdx < mediaPos.length) {
        const keepPos = mediaPos[voiceIdx];
        const out = srcLines.map((ln, i) => {
          if (ln.indexOf('#EXT-X-MEDIA:') !== 0) return ln;
          if (i !== keepPos) return null;
          return ln.replace(/DEFAULT=[A-Z]+/, 'DEFAULT=YES').replace(/AUTOSELECT=[A-Z]+/, 'AUTOSELECT=YES');
        }).filter(l => l !== null).join('\n');
        return res.end(out);
      }
    }
    fs.createReadStream(m3u8Path).pipe(res);
  } catch (e) {
    log.error('HLS', `master.m3u8 生成失败: id=${song.id} "${song.filename}": ${e.message}`);
    res.status(500).end();
  }
});

// 原生HLS端(无MSE的iPad/tvOS)查询本歌演唱档位数与档位名：直接解析已生成 master.m3u8
// 里的 EXT-X-MEDIA，和实际下发完全一致。hls.js 端从 audioTracks 自取，无需调用。
app.get('/api/songs/:id/voice-tracks', async (req, res) => {
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(req.params.id);
  if (!song) return res.status(404).json({ error: 'not found' });
  try {
    if (song.audio_tracks == null && (song.is_network || song.is_strm)) {
      song.audio_tracks = await ensureProbedOnDemand(song);
    }
    const m3u8Path = await ensureHLS(song);
    const names = [];
    fs.readFileSync(m3u8Path, 'utf8').split('\n').forEach(ln => {
      if (ln.indexOf('#EXT-X-MEDIA:') !== 0) return;
      const m = ln.match(/NAME="([^"]*)"/);
      names.push(m ? m[1] : ('音轨' + (names.length + 1)));
    });
    res.json({ tracks: names.length, names });
  } catch (e) {
    log.error('HLS', `voice-tracks 查询失败: id=${song.id}: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// 子播放列表(video.m3u8/audioN.m3u8)与分片(.ts)。file 名做白名单校验防止路径穿越，
// id 也强制要求纯数字，避免拼接出 outDir 之外的路径。
//
// 渐进式转码下，这些文件是随着后台 ffmpeg 进程持续产出的：播放器可能会在
// 某个分片刚好还没转出来的瞬间发出请求。这里不再"文件不存在就直接 404"，
// 而是短暂轮询等待它出现（waitForFile），一旦转码进度追上就立即响应——
// 真正做到"随出随播"，而不是让播放器自己重试或者干等整首歌转完。如果这
// 首歌的转码任务本身已经失败，或者等待太久都没等到（比如源文件损坏、卡在
// 极端情况），才会明确地报错而不是无限期挂起请求。
app.get('/hls/:id/:file', async (req, res) => {
  const { id, file } = req.params;
  if (!/^\d+$/.test(id) || !/^[\w.-]+$/.test(file)) return res.status(400).end();
  const p = path.join(outDir(id), file);

  let ready = fs.existsSync(p);
  if (!ready) {
    try {
      await waitForFile(p, id);
      ready = true;
    } catch (e) {
      if (e.code === 'BUILD_FAILED') {
        log.error('HLS', `分片生成失败: id=${id}, file=${file}: ${e.cause && e.cause.message}`);
        return res.status(500).end();
      }
      log.warn('HLS', `等待分片超时: id=${id}, file=${file}`);
      return res.status(404).end(); // 等待超时，视为确实不存在（例如非法文件名/已被清理）
    }
  }

  if (file.endsWith('.m3u8')) res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store' });
  else if (file.endsWith('.ts')) res.set({ 'Content-Type': 'video/mp2t', 'Cache-Control': 'public, max-age=31536000, immutable' });
  fs.createReadStream(p).pipe(res);
});

// ---------- 硬解(客户端解码)诊断：源文件编解码信息探测 ----------
// Android 客户端在"硬解模式"下不走服务端转码，而是直接请求 /stream/:id 拿到
// 原始文件字节，交给设备自带的硬件解码器(MediaCodec)解码播放。这条路径完全
// 在客户端设备上完成解码，服务端本身"看不见"解码过程本身是否正常——但很多
// 硬解播放失败的根本原因(源文件编码不是设备硬件解码器支持的格式/画质、色彩
// 空间、码率过高导致的兼容性问题等)其实可以在服务端提前用 ffprobe 探测出来，
// 打进日志，方便管理员排查"某首歌在硬解模式下放不出来"到底是不是文件本身的
// 问题。probeCodecInfo 结果按歌曲 id 缓存，避免同一首歌被反复请求时重复探测。
const codecInfoCache = new Map(); // song_id -> { videoCodec, videoProfile, width, height, audioCodec, audioChannels, probedAt }

async function probeCodecInfo(song, srcPath) {
  const cached = codecInfoCache.get(song.id);
  if (cached) return cached;
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,profile,width,height,channels',
      '-of', 'json',
      srcPath || song.filepath,
    ], { timeout: 15000 });
    const info = JSON.parse(stdout);
    const v = (info.streams || []).find(s => s.codec_type === 'video') || {};
    const a = (info.streams || []).find(s => s.codec_type === 'audio') || {};
    const result = {
      videoCodec: v.codec_name || '未知', videoProfile: v.profile || '未知',
      width: v.width || 0, height: v.height || 0,
      audioCodec: a.codec_name || '未知', audioChannels: a.channels || 0,
      probedAt: Date.now(),
    };
    codecInfoCache.set(song.id, result);
    return result;
  } catch (e) {
    log.warn('STREAM', `[歌曲 id=${song.id}] ffprobe 编解码信息探测失败，不影响直连播放本身，仅缺少诊断信息: ${e.message.split('\n')[0]}`);
    return null;
  }
}

// ---------- 客户端(Android/TV等)解码模式上报 ----------
// 硬解(客户端解码，走 /stream/:id 直连原始文件)与软解(服务端解码/转码，走
// /hls/:id/master.m3u8)完全由客户端自行选择、自行切换，服务端本身不参与决策，
// 也就无从知晓某台设备当前用的是哪种模式。这里加一个轻量上报接口，由 Android
// 客户端在设置里切换模式、或者每次开始播放一首新歌时调用一次，把决策结果和
// 关键上下文(设备型号、Android 版本、是否命中源文件编解码兼容性问题等)一起
// 打进 docker 后台日志，方便管理员排查"这台电视/盒子播不出来，到底是硬解
// 解码器不支持这个源文件，还是应该切到软解"这类问题。上报失败不影响播放本身，
// 客户端按 fire-and-forget 方式调用即可。
app.post('/api/decode-mode/report', async (req, res) => {
  const { song_id, mode, device, reason } = req.body || {};
  const modeName = mode === 'hardware' ? '硬解(客户端解码)' : mode === 'software' ? '软解(服务端解码/转码)' : (mode || '未知');
  // Bug修复：把客户端上报的解码模式同步给 queuePreload，让"已点队列后台预热
  // 转码"感知到当前是硬解还是软解，硬解模式下不再对预热窗口里的歌无条件
  // 触发 ensureHLS 转码(具体原因见 queuePreload.js 里 setDecodeMode 的注释)。
  setDecodeMode(mode);
  const song = song_id ? db.prepare('SELECT id, title, filename, filepath, audio_tracks, audio_needs_soft, video_needs_soft FROM songs WHERE id = ?').get(song_id) : null;
  const songTag = song ? `id=${song.id} "${song.title || song.filename}"` : `id=${song_id || '未知'}`;
  const deviceTag = device ? `设备[${device}]` : '设备[未知]';

  let extra = '';
  if (song && mode === 'hardware') {
    const codec = await probeCodecInfo(song);
    if (codec) {
      extra = ` | 源文件: 视频=${codec.videoCodec}/${codec.videoProfile} ${codec.width}x${codec.height}, 音频=${codec.audioCodec} ${codec.audioChannels}声道, 音轨数=${song.audio_tracks || 1}`;
      // h264 High/Main 4K 以下、AAC 音频通常绝大多数 Android 设备硬件解码器都能支持；
      // 其它编码(HEVC 高规格/AV1 等)在部分低端设备上可能没有对应硬件解码器，只是
      // 提示，不代表一定放不出来，具体仍以客户端实际反馈的播放结果为准。
      if (!/^h264$/i.test(codec.videoCodec) && codec.videoCodec !== '未知') {
        extra += ' | 提示: 非 H.264 编码，部分老旧/低端 Android 设备硬件解码器可能不支持，若该设备反馈硬解播放失败或花屏，建议切换到软解模式';
      }
      // 需求修复("硬解直连没声音，切音轨才报硬解失败自动切软解")：mp2 音频在
      // 不少 Android 设备上没有对应 MediaCodec，画面能出但没声音，直到切音轨
      // 才报错。这里除了打提示日志，还顺手把探测结果回写进 songs 表——如果
      // 这首歌是老版本扫描/探测的(那时候还没有 audio_needs_soft 这一列)，
      // 客户端就不用再"先硬解无声播放一次"才能拿到正确判定，下次点这首歌
      // 就能直接从服务端拿到 audio_needs_soft=1，一开始就走软解。
      if (isProblemAudioCodec(codec.audioCodec)) {
        extra += ` | 提示: 音频编码=${codec.audioCodec}，部分 Android 设备硬件/软件解码器不支持此音频编码(画面正常但没有声音)，建议切换到软解模式`;
        if (!song.audio_needs_soft) {
          db.prepare('UPDATE songs SET audio_needs_soft = 1 WHERE id = ?').run(song.id);
        }
      }
      // 需求修复("RV40硬解黑屏，声音正常")：跟上面 mp2 音频同一处自愈回填，
      // 只是这里是视频编码——老曲目(扫描时还没有 video_needs_soft 这一列，或
      // 者当时的 PROBLEM_VIDEO_CODECS 名单里还没有这个编码)第一次上报硬解模式
      // 时顺手探测一次，命中已知有问题的视频编码就回填，之后点这首歌客户端
      // 会直接从服务端拿到 video_needs_soft=1，一开始就走软解，不会再黑屏。
      if (isProblemVideoCodec(codec.videoCodec)) {
        extra += ` | 提示: 视频编码=${codec.videoCodec}，Android 设备硬件解码器基本不支持(即使能初始化也大概率黑屏)，建议切换到软解模式`;
        if (!song.video_needs_soft) {
          db.prepare('UPDATE songs SET video_needs_soft = 1 WHERE id = ?').run(song.id);
        }
      }
    }
  }
  const reasonTag = reason ? `，触发原因: ${reason}` : '';
  log.info('DECODE', `${deviceTag} 切换解码模式 -> ${modeName}${reasonTag} | 当前曲目: ${songTag}${extra}`);
  res.json({ ok: true });
});

// ---------- MV 直传流 (Range 请求) ----------
// 历史接口，现已不是 TV 播放器的主路径(见上面的 /hls)。保留作为兼容兜底：
// 例如 hls.js 加载失败、或未来某个场景需要拿到原始文件直传时使用。仍支持
// ?track=0/1（对多音轨文件用 ffmpeg -c copy 现场重新封装出单音轨流），但注意
// 这个分支吐出的流不支持 Range/寻址，只适合"整段从头播完"的用途，不要再用它
// 做音轨切换后还要拖进度条的场景——那正是旧 bug 的根因，具体解释见 /hls 路由。
app.get('/stream/:id', async (req, res) => {
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(req.params.id);
  const songTag = song ? `id=${song.id} "${song.title || song.filename}"` : `id=${req.params.id}`;
  const ua = req.headers['user-agent'] || '未知客户端';
  // 需求(网盘先缓存到本地再探测/播放)：硬解直连模式服务端只做字节直传，完全
  // 不参与解码，网络挂载曲库如果没有本地缓存兜底，每一次 Range 拖进度都要
  // 走一次网络读取，卡顿和不稳定会比软解(HLS)更明显——这里同样优先用本地
  // 缓存副本，没缓存好就退回网络路径直传(可用但可能不够流畅)，后台同时在
  // 悄悄补缓存。本地曲库的歌 srcPath 就是原来的 song.filepath，行为不变。
  let srcPath = song ? sourceCache.resolvePlaybackPath(song).path : null;

  // Bug修复("STRM 歌曲硬解全部失败，只有自动切换软解才能播放")：
  // resolvePlaybackPath() 对网络挂载曲目在没缓存好时还能退回"直接读网络路径"
  // 当兜底，但 STRM 曲目的 filepath 只是本地几十字节的文本指针，没有这个
  // 兜底可用，只能如实返回 path: null(见 sourceCache.js 里的注释)。这里以前
  // 直接把 null 当"文件不存在"处理，立刻 404——而 STRM 曲目第一次被点播时，
  // 本地缓存必然还没就绪，等于"硬解模式下这首歌的第一次播放请求必然 404"，
  // 客户端于是照它自己的"硬解失败就自动退到软解"逻辑切过去，表现上看就是
  // "STRM 歌曲硬解全部失败"。软解(/hls/:id/master.m3u8 -> ensureHLS())之所以
  // 能正常播放，是因为它已经在为同样的场景 await 一次 ensureCached()(见
  // hlsgen.js ensureHLS() 里的对应注释)——这里补上同一步：STRM 曲目缓存没
  // 准备好时，硬解直连也老老实实等一次缓存落地，而不是直接判"文件不存在"。
  // 用户感知上只是这首歌硬解模式下第一次播放会多等一下下载时间，之后
  // (缓存已就绪)走 resolvePlaybackPath() 直接命中本地缓存，跟本地曲库一样快，
  // 不会再退回软解。
  if (song && !srcPath && song.is_strm) {
    try {
      srcPath = await sourceCache.ensureCached(song.id, sourceCache.resolveSourceInput(song.filepath));
    } catch (e) {
      log.error('STREAM', `[硬解直连] ${songTag} STRM 源缓存失败，无法播放: ${e.message}`);
      srcPath = null;
    }
  }

  if (!song || !srcPath || !fs.existsSync(srcPath)) {
    log.warn('STREAM', `[硬解直连] 请求失败(文件不存在): ${songTag}，客户端: ${ua}`);
    return res.status(404).end();
  }

  const trackParam = req.query.track;
  const hasMultiTrack = (song.audio_tracks || 1) >= 2;
  const t0 = Date.now();

  if (trackParam !== undefined && hasMultiTrack) {
    const track = Math.max(0, Math.min(parseInt(trackParam, 10) || 0, song.audio_tracks - 1));
    log.info('STREAM', `[硬解直连-兜底封装] ${songTag} 音轨=${track}(${track === 0 ? '原唱' : '伴唱'}) 客户端: ${ua} —— 注意: 此分支现场用 ffmpeg 重新封装单音轨，不支持 Range/拖进度，仅作为客户端设备不支持内嵌多音轨切换时的兜底`);
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'none',   // 现场重新封装，长度未知，无法支持 Range 拖进度
      'Cache-Control': 'no-store',
    });
    const ff = spawn('ffmpeg', [
      '-loglevel', 'error',
      '-i', srcPath,
      '-map', '0:v:0',
      '-map', `0:a:${track}`,
      '-c', 'copy',
      '-movflags', 'frag_keyframe+empty_moov+faststart',
      '-f', 'mp4',
      'pipe:1',
    ]);
    let responded = false;
    ff.stdout.pipe(res);
    ff.stderr.on('data', d => log.warn('TRANSCODE', `[stream直传兜底][ffmpeg] ${d.toString().trim()}`));
    const cleanup = () => { if (!ff.killed) { try { ff.kill('SIGKILL'); } catch (e) {} } };
    ff.on('error', err => { log.error('TRANSCODE', `[stream直传兜底] ffmpeg 启动失败: ${err.message}`); if (!responded) { responded = true; res.status(500).end(); } cleanup(); });
    ff.on('close', code => log.info('STREAM', `[硬解直连-兜底封装] ${songTag} 音轨=${track} 结束，耗时 ${Date.now() - t0}ms，退出码 ${code}`));
    res.on('close', cleanup);
    return;
  }

  // 首次命中时顺带做一次编解码信息探测并打进日志——硬解模式下播放是否流畅、
  // 是否能正常解码完全取决于设备硬件解码器对源编码的支持程度，服务端只做
  // 纯字节直传(可寻址 Range 请求)，本身不参与解码，所以在这里主动留一份
  // "这首歌到底是什么编码"的诊断记录，管理员看到某设备反馈硬解播放异常时
  // 能直接对照日志判断是否是源文件编码兼容性问题。
  if (!codecInfoCache.has(song.id)) {
    probeCodecInfo(song, srcPath).then(info => {
      if (info) {
        log.info('STREAM', `[硬解直连] ${songTag} 源编解码信息: 视频=${info.videoCodec}/${info.videoProfile} ${info.width}x${info.height}, 音频=${info.audioCodec} ${info.audioChannels}声道, 音轨数=${song.audio_tracks || 1}(内嵌多音轨由客户端硬件解码器/播放器自行切换，服务端不参与)`);
        // 同一处自愈回填：老曲目(扫描时还没有 audio_needs_soft 这一列)第一次
        // 走硬解直连被探测到问题音频编码时，顺手把结果落库，见上面
        // /api/decode-mode/report 里的详细注释。
        if (isProblemAudioCodec(info.audioCodec) && !song.audio_needs_soft) {
          db.prepare('UPDATE songs SET audio_needs_soft = 1 WHERE id = ?').run(song.id);
          log.warn('STREAM', `[硬解直连] ${songTag} 音频编码=${info.audioCodec} 已知在部分设备上硬解无声音，已标记 audio_needs_soft，之后点这首歌客户端会直接走软解`);
        }
        // 需求修复("RV40硬解黑屏，声音正常")：同上，视频编码版本的自愈回填。
        if (isProblemVideoCodec(info.videoCodec) && !song.video_needs_soft) {
          db.prepare('UPDATE songs SET video_needs_soft = 1 WHERE id = ?').run(song.id);
          log.warn('STREAM', `[硬解直连] ${songTag} 视频编码=${info.videoCodec} 已知在 Android 设备上硬解基本必黑屏(即使能初始化解码器也大概率不出画面)，已标记 video_needs_soft，之后点这首歌客户端会直接走软解`);
        }
      }
    }).catch(() => {});
  }

  const stat = fs.statSync(srcPath);
  const range = req.headers.range;
  if (!range) {
    log.info('STREAM', `[硬解直连] ${songTag} 完整文件请求(无 Range 头，${(stat.size / 1024 / 1024).toFixed(1)}MB)，客户端: ${ua}`);
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'video/mp4' });
    return fs.createReadStream(srcPath).pipe(res);
  }
  const [s, e] = range.replace(/bytes=/, '').split('-');
  const start = parseInt(s, 10);
  const end = e ? parseInt(e, 10) : stat.size - 1;
  log.info('STREAM', `[硬解直连] ${songTag} Range 请求: bytes=${start}-${end}/${stat.size} (${((end - start + 1) / 1024).toFixed(0)}KB)，客户端: ${ua}`);
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': 'video/mp4',
  });
  const readStream = fs.createReadStream(srcPath, { start, end });
  readStream.on('error', err => log.error('STREAM', `[硬解直连] ${songTag} 读取源文件失败: ${err.message}`));
  readStream.pipe(res);
});

// ---------- 原唱/伴唱切换状态上报 ----------
// 实际的切换动作(hls.audioTrack=0/1 或者声道复制)完全发生在浏览器端
// (见 web/tv/index.html 的 VoiceManager)，服务端本身并不参与、也就无从
// 知晓用户什么时候切了原唱/伴唱。这里加一个轻量上报接口，由前端在每次
// 切换后调用一次，让这个状态变化也能进 docker 后台日志，方便排查
// "切了没生效"之类的问题。上报失败与否不影响播放本身，前端是 fire-and-forget。
app.post('/api/voice/switch', (req, res) => {
  const { song_id, mode, to } = req.body || {};
  const song = song_id ? db.prepare('SELECT id, title, filename FROM songs WHERE id = ?').get(song_id) : null;
  const songTag = song ? `id=${song.id} "${song.title || song.filename}"` : `id=${song_id || '未知'}`;
  const toName = to === 'original' ? '原唱' : to === 'accompaniment' ? '伴唱' : (to || '未知');
  const modeName = mode === 'tracks' ? '多音轨(HLS audioTrack)' : mode === 'stereo' ? '双声道(Web Audio 声道复制)' : (mode || '未知');
  log.info('VOICE', `切换音轨: ${songTag} -> ${toName} (方式: ${modeName})`);
  res.json({ ok: true });
});

// ---------- 歌曲库 ----------
// 分页支持：TV 端 / 手机点歌页需要一次性拿到完整曲库做本地按首字母浏览、
// 排序等操作，历史上一直是"不带 page 参数 = 返回全部"，所以这里保持完全
// 向后兼容——只有当请求显式带上 page & pageSize 时才走分页分支，返回
// { items, total, page, pageSize, totalPages } 这种带元信息的对象；不带
// 分页参数时仍然和以前一样直接返回数组，不影响 TV 端/手机端现有逻辑。
// 「曲库管理」后台页面现在用分页参数（每页 50 首）来避免曲库很大时一次性
// 把几千首歌整页渲染进 DOM 导致的加载卡顿。
// ============ 歌词（音频K歌改造）============
// 取一首歌的歌词：DB 已有则直接返回(不联网、最快)；没有则按"本地同名lrc→在线三源"
// 找一次，找到就落库。forceOnline=true 时忽略 DB 已有结果强制在线重抓。
// 检测歌词是否乱码（含 Unicode 替换字符 U+FFFD，或高比例不可打印字符）
function isLyricsMojibake(text) {
  if (!text) return false;
  if (text.includes('\uFFFD')) return true;
  // 统计非 ASCII 可打印字符中，乱码常见的私有区/控制符比例
  let bad = 0, total = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code > 127) {
      total++;
      // 乱码常见范围：Latin-1 补充(0x80-0xFF)、通用标点区异常、私有区
      if (code >= 0x80 && code <= 0xFF) bad++;
      else if (code >= 0xE000 && code <= 0xF8FF) bad++; // 私有区
    }
  }
  return total > 10 && bad / total > 0.3;
}

async function obtainLyrics(song, { forceOnline = false } = {}) {
  // DB 已有歌词且不是乱码 → 直接返回(最快)；是乱码则忽略，重新走本地/在线获取
  if (song.lyrics && !forceOnline && !isLyricsMojibake(song.lyrics)) {
    return { lrc: song.lyrics, source: song.lyrics_source || 'stored', lines: lyricsMod.parseLrc(song.lyrics).length };
  }
  const r = await lyricsMod.resolveLyrics(song, { allowOnline: true });
  if (r && r.lrc) {
    db.prepare('UPDATE songs SET lyrics=?, lyrics_source=? WHERE id=?').run(r.lrc, r.source, song.id);
    return { lrc: r.lrc, source: r.source, lines: lyricsMod.parseLrc(r.lrc).length };
  }
  // 在线/本地都没拿到，但 DB 有乱码歌词 → 至少返回乱码的（比没有强），但标记 source
  if (song.lyrics) return { lrc: song.lyrics, source: (song.lyrics_source || 'stored') + '(mojibake)', lines: lyricsMod.parseLrc(song.lyrics).length };
  return null;
}

// GET /api/songs/:id/lyrics?online=1 —— 取歌词（默认缺词时在线补一次）
app.get('/api/songs/:id/lyrics', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
    const song = db.prepare('SELECT * FROM songs WHERE id=?').get(id);
    if (!song) return res.status(404).json({ error: 'song not found' });
    const allowOnline = req.query.online !== '0';
    const r = allowOnline ? await obtainLyrics(song) : (song.lyrics ? { lrc: song.lyrics, source: song.lyrics_source || 'stored' } : null);
    if (!r) return res.status(404).json({ id, lyrics: null, message: '暂无歌词（本地无同名lrc，在线三源也未命中）' });
    res.json({ id, title: song.title, artist: song.artist, lyrics: r.lrc,
               word: song.lyrics_word || null, align_status: song.align_status || 'none',
               mediaType: song.media_type || null, filename: song.filename || '',
               filepath: song.filepath || '', source: r.source });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/songs/:id/lyrics/fetch —— 强制在线重新抓取
app.post('/api/songs/:id/lyrics/fetch', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const song = db.prepare('SELECT * FROM songs WHERE id=?').get(id);
    if (!song) return res.status(404).json({ error: 'song not found' });
    const r = await obtainLyrics(song, { forceOnline: true });
    if (!r) return res.status(404).json({ id, lyrics: null, message: '在线三源均未命中' });
    res.json({ id, lyrics: r.lrc, word: song.lyrics_word || null, source: r.source });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 把秒数格式化为 [mm:ss.xx]（负时间钳到 0）
function shiftLrcTimestamp(lrc, deltaSec) {
  if (!lrc) return lrc;
  const fmt = (sec) => {
    if (sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const rest = sec - m * 60;
    const ss = rest.toFixed(2).padStart(5, '0');
    return String(m).padStart(2, '0') + ':' + ss;
  };
  // 同时平移行时间标签 [mm:ss.xx] 和逐字标签 <mm:ss.xx>
  return lrc.replace(/[\[<](\d{1,3}):(\d{1,2}(?:\.\d+)?)\s*[\]>]/g, (m) => {
    const open = m[0];
    const close = open === '[' ? ']' : '>';
    const inner = m.slice(1, -1);
    const parts = inner.split(':');
    const t = parseInt(parts[0], 10) * 60 + parseFloat(parts[1]) + deltaSec;
    return open + fmt(t) + close;
  });
}

// POST /api/songs/:id/lyrics/offset  body:{offset:秒(增量)} —— 把歌词全部时间标签平移增量并写回数据库（固化唱字同步校准）
app.post('/api/songs/:id/lyrics/offset', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
    const delta = parseFloat(req.body && req.body.offset);
    if (!Number.isFinite(delta) || Math.abs(delta) > 30) return res.status(400).json({ error: 'bad offset' });
    const song = db.prepare('SELECT * FROM songs WHERE id=?').get(id);
    if (!song) return res.status(404).json({ error: 'song not found' });
    const newLyrics = song.lyrics ? shiftLrcTimestamp(song.lyrics, delta) : null;
    const newWord = song.lyrics_word ? shiftLrcTimestamp(song.lyrics_word, delta) : null;
    db.prepare('UPDATE songs SET lyrics=?, lyrics_word=? WHERE id=?').run(newLyrics, newWord, id);
    res.json({ id, ok: true, appliedDelta: delta });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 批量补抓状态（防止重复跑），GET 可查进度
let lyricBatch = { running: false, total: 0, done: 0, ok: 0, fail: 0, startedAt: null, finishedAt: null };

// POST /api/lyrics/batch-missing?limit=200 —— 后台串行给缺词歌曲在线补抓（限速）
app.post('/api/lyrics/batch-missing', (req, res) => {
  if (lyricBatch.running) return res.status(409).json({ message: '已有批量补抓任务在跑', state: lyricBatch });
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isInteger(limit) || limit <= 0) limit = 200;
  limit = Math.min(limit, 1000);
  const rows = db.prepare("SELECT * FROM songs WHERE (lyrics IS NULL OR lyrics='') ORDER BY id LIMIT ?").all(limit);
  lyricBatch = { running: true, total: rows.length, done: 0, ok: 0, fail: 0, startedAt: Date.now(), finishedAt: null };
  res.json({ message: `已开始后台补抓 ${rows.length} 首`, state: lyricBatch });
  (async () => {
    for (const song of rows) {
      try {
        const r = await lyricsMod.resolveLyrics(song, { allowOnline: true });
        if (r && r.lrc) { db.prepare('UPDATE songs SET lyrics=?, lyrics_source=? WHERE id=?').run(r.lrc, r.source, song.id); lyricBatch.ok++; }
        else lyricBatch.fail++;
      } catch (e) { lyricBatch.fail++; }
      lyricBatch.done++;
      await sleep(800); // 串行 + 限速，避免触发歌词站反爬/封 IP
    }
    lyricBatch.running = false;
    lyricBatch.finishedAt = Date.now();
    log.info('LYRICS', `批量补抓完成：共 ${lyricBatch.total}，成功 ${lyricBatch.ok}，未命中 ${lyricBatch.fail}`);
  })();
});

// GET /api/lyrics/stats —— 歌词覆盖率与批量任务进度
app.get('/api/lyrics/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) c FROM songs').get().c;
  const has = db.prepare("SELECT COUNT(*) c FROM songs WHERE lyrics IS NOT NULL AND lyrics<>''").get().c;
  const bySrc = db.prepare('SELECT lyrics_source, COUNT(*) c FROM songs WHERE lyrics IS NOT NULL GROUP BY lyrics_source').all();
  res.json({ total, hasLyrics: has, missing: total - has, coverage: total ? +(has / total * 100).toFixed(1) : 0, bySource: bySrc, batch: lyricBatch });
});

// ============ AI 人声分离 / 逐字对齐 任务队列（音频K歌改造 P2）============
// 真正吃 GPU 的 Demucs/WhisperX 跑在独立 worker(Windows+N卡)，服务端只做队列调度、
// 源音频下发、产物回收。worker 流程：claim 领任务 -> GET source 下载 -> 本地推理 ->
// multipart complete 回传 vocals/accompaniment wav（及逐字歌词）。

// 每 5 分钟回收 worker 崩溃留下的 processing 僵尸任务（超 20 分钟未完成 -> 重新排队）
setInterval(() => { try { sepMod.reclaimStale(db, 20); } catch (e) { /* 忽略 */ } }, 5 * 60 * 1000);

// POST /api/separate/enqueue  body {song_ids:[...], type:'separate'|'align'|'both', force:false}
app.post('/api/separate/enqueue', (req, res) => {
  try {
    const { song_ids = [], type = 'separate', force = false } = req.body || {};
    const r = sepMod.enqueue(db, { songIds: song_ids, type, force: !!force });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/separate/enqueue-missing?type=separate&limit=100 —— 把缺分离/对齐的音频歌批量入队
app.post('/api/separate/enqueue-missing', (req, res) => {
  const type = req.query.type || (req.body && req.body.type) || 'separate';
  let limit = parseInt(req.query.limit || (req.body && req.body.limit), 10);
  if (!Number.isInteger(limit) || limit <= 0) limit = 100;
  limit = Math.min(limit, 5000);
  const col = type === 'align' ? 'align_status' : 'sep_status';
  const rows = db.prepare(
    `SELECT id FROM songs WHERE media_type IN ('audio','cue') AND (${col} IS NULL OR ${col}='none' OR ${col}='failed') ORDER BY id LIMIT ?`
  ).all(limit);
  const r = sepMod.enqueue(db, { songIds: rows.map(x => x.id), type });
  res.json({ ok: true, candidates: rows.length, ...r });
});

// GET /api/separate/jobs/claim?worker=pc-51&type=separate&capability=gpu —— worker 领取任务（无任务返回 204）
app.get('/api/separate/jobs/claim', (req, res) => {
  const worker = String(req.query.worker || 'anonymous').slice(0, 64);
  const type = String(req.query.type || 'separate');
  const capability = String(req.query.capability || 'cpu') === 'gpu' ? 'gpu' : 'cpu';
  const task = sepMod.claimNext(db, { worker, type, capability });
  if (!task) return res.status(204).end();
  task.sourceUrl = `http://${req.get('host')}${task.sourceUrl}`; // 补全为 worker 可直接下载的绝对地址
  res.json(task);
});

// POST /api/separate/jobs/:id/progress  {progress:0-100, worker, capability}
app.post('/api/separate/jobs/:id/progress', (req, res) => {
  // 进度上报同时充当"处理长任务期间"的心跳，避免 worker 正在跑一首长歌时被误判离线
  if (req.body && req.body.worker) sepMod.touchWorker(req.body.worker, req.body.capability);
  sepMod.reportProgress(db, parseInt(req.params.id, 10), req.body && req.body.progress);
  res.json({ ok: true });
});

// POST /api/separate/jobs/:id/complete —— multipart 回传产物：
//   files: vocals(人声wav) / accompaniment(伴奏wav) / wordLrc(逐字歌词)；也可走字段 wordLrc
app.post('/api/separate/jobs/:id/complete', sepUpload.fields([
  { name: 'vocals', maxCount: 1 }, { name: 'accompaniment', maxCount: 1 }, { name: 'wordLrc', maxCount: 1 },
]), async (req, res) => {
  try {
    const jobId = parseInt(req.params.id, 10);
    const job = db.prepare('SELECT * FROM separation_jobs WHERE id=?').get(jobId);
    if (!job) return res.status(404).json({ error: 'job not found' });
    const files = req.files || {};
    // 分离产物目录用源文件路径的 SHA256(sepKey)，而非 song.id——重新入库后 id 变了也能复用
    const sepKey = sepMod.sepKeyForSong(db, job.song_id) || String(job.song_id);
    const dir = sepMod.ensureSepDir(sepKey);
    const saved = {};
    // 一步到 FLAC：worker 回传的是 Demucs 原始 wav，服务端落盘前统一用 ffmpeg 无损转成 FLAC
    //（FLAC 无损、体积约为 wav 一半；读取端 resolveSepTrackFile 早已按 flac 优先、wav 兜底）。
    // 若容器内 ffmpeg 转换失败，回退直接保留 wav，绝不让整首分离因为压缩而失败/丢产物。
    const convertTrack = async (f, stem) => {
      if (!f || !f[0] || !f[0].buffer) return;
      const buf = f[0].buffer;
      const tmpWav = path.join(dir, stem + '._in.wav');
      const flacP = path.join(dir, stem + '.flac');
      const wavP = path.join(dir, stem + '.wav');
      fs.writeFileSync(tmpWav, buf);
      try {
        await execFileAsync('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmpWav, '-vn', '-c:a', 'flac', '-compression_level', '5', flacP]);
        if (!fs.existsSync(flacP) || fs.statSync(flacP).size <= 1024) throw new Error('flac output too small');
        try { fs.unlinkSync(tmpWav); } catch (e) {}
        try { if (fs.existsSync(wavP)) fs.unlinkSync(wavP); } catch (e) {}
        saved[stem + '.flac'] = fs.statSync(flacP).size;
      } catch (e) {
        try { if (fs.existsSync(flacP)) fs.unlinkSync(flacP); } catch (e2) {}
        try { fs.renameSync(tmpWav, wavP); } catch (e2) { fs.writeFileSync(wavP, buf); }
        saved[stem + '.wav'] = buf.length;
        log.warn('SEP', `[job ${jobId}] ${stem} wav→flac 转换失败，回退保留 wav: ${e.message}`);
      }
    };
    await Promise.all([convertTrack(files.vocals, 'vocals'), convertTrack(files.accompaniment, 'accompaniment')]);
    let lyricsWord = null;
    if (files.wordLrc && files.wordLrc[0]) lyricsWord = files.wordLrc[0].buffer.toString('utf8');
    else if (req.body && req.body.wordLrc) lyricsWord = String(req.body.wordLrc);
    const done = sepMod.complete(db, jobId, { lyricsWord, result: { saved, worker: job.worker } });
    // 分离产物到位后清掉这首歌旧 HLS，下次播放按"原唱/半消/伴奏"三轨重新生成（P4）
    try { removeHLS(job.song_id); } catch (e) { /* 旧产物不存在无妨 */ }
    // 逐字歌词重新生成完成：WebSocket广播给所有客户端，tvOS端收到后无缝替换当前歌词（不清空、不中断播放）
    if (lyricsWord) {
      try {
        const payload = JSON.stringify({ type: 'lyrics_updated', songId: job.song_id });
        wss.clients.forEach(c => { if (c._channel === 'ws' && c.readyState === 1) c.send(payload); });
        log.info('LYRIC', `[歌曲 id=${job.song_id}] 逐字歌词重新生成完成，已广播 lyrics_updated`);
      } catch (e) { log.warn('LYRIC', `广播 lyrics_updated 失败: ${e.message}`); }
    }
    res.json({ ok: true, status: done.status, saved });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/separate/jobs/:id/fail  {error}
app.post('/api/separate/jobs/:id/fail', (req, res) => {
  sepMod.fail(db, parseInt(req.params.id, 10), (req.body && req.body.error) || 'worker failed');
  res.json({ ok: true });
});
// POST /api/separate/jobs/:id/reset —— 手动重置为排队
app.post('/api/separate/jobs/:id/reset', (req, res) => {
  sepMod.resetJob(db, parseInt(req.params.id, 10));
  res.json({ ok: true });
});
// GET /api/separate/stats —— 分离/对齐进度看板
app.get('/api/separate/stats', (req, res) => res.json(sepMod.stats(db)));
// GET /api/separate/jobs?status= —— 任务列表（看板/调试，最多500）
app.get('/api/separate/jobs', (req, res) => {
  const status = req.query.status;
  const sql = 'SELECT j.*, s.title, s.artist FROM separation_jobs j LEFT JOIN songs s ON s.id=j.song_id';
  const rows = status
    ? db.prepare(sql + ' WHERE j.status=? ORDER BY j.id DESC LIMIT 500').all(status)
    : db.prepare(sql + ' ORDER BY j.id DESC LIMIT 500').all();
  res.json(rows);
});

// ==================== 分离双轨直出（网页端连续人声滑块 DUAL 模式）====================
// 旧方案：hlsgen 把人声按 0/75/50/25/0 预混成 5 条 AAC 离散音轨，前端只能跳档切换、
// 且每次切换要重新拉分片，做不到丝滑连续消音。新方案：分离出的 vocals / accompaniment
// 两条原始分轨直接以支持 Range(206) 的静态文件下发，网页端用两个 <audio> + WebAudio
// GainNode 连续调节人声音量，伴奏恒定，从而得到无跳档、无重载的丝滑滑块。存储层以后
// 一步到 FLAC，这里按"优先 .flac、回退 .wav"自动适配，存量 wav 与未来 flac 都能播。

// 解析某首歌某条分轨在磁盘上的真实文件（flac 优先、wav 兜底），不存在返回 null
function resolveSepTrackFile(song, kind) {
  if (!song) return null;
  const rel = kind === 'vocal' ? song.vocal_path : song.accomp_path;
  if (!rel) return null;
  const base = String(rel).replace(/\.(wav|flac)$/i, '');
  const candidates = [base + '.flac', base + '.wav', String(rel)];
  for (const c of candidates) {
    try {
      const abs = sepMod.absUnderData(c);
      if (abs && fs.existsSync(abs) && fs.statSync(abs).size > 1024) {
        return { abs, ext: path.extname(abs).slice(1).toLowerCase() };
      }
    } catch (e) { /* 试下一个候选 */ }
  }
  return null;
}

// 带 HTTP Range / 206 的文件发送（语义与 /stream/:id 一致，供 <audio> 边下边播、拖动寻址）
function sendFileWithRange(req, res, abs, contentType) {
  let stat;
  try { stat = fs.statSync(abs); } catch (e) { return res.status(404).end(); }
  const total = stat.size;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : total - 1;
    if (Number.isNaN(start)) start = 0;
    if (Number.isNaN(end) || end >= total) end = total - 1;
    if (start > end || start >= total) {
      res.status(416).setHeader('Content-Range', `bytes */${total}`);
      return res.end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', end - start + 1);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(abs, { start, end }).on('error', () => { try { res.destroy(); } catch (e) {} }).pipe(res);
  } else {
    res.setHeader('Content-Length', total);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(abs).on('error', () => { try { res.destroy(); } catch (e) {} }).pipe(res);
  }
}

// GET /api/songs/:id/sep-info —— 前端能力探测：这首歌两条分轨是否齐备、各自的直出地址
app.get('/api/songs/:id/sep-info', (req, res) => {
  const song = db.prepare('SELECT * FROM songs WHERE id=?').get(parseInt(req.params.id, 10));
  if (!song) return res.status(404).json({ error: 'not found', dual: false });
  const id = song.id;

  // 网络KTV MKV视频（115网盘单文件多音轨）：返回视频直链，走单文件播放+音轨切换
  if (song.source_root === 'netktv-mkv') {
    // 从STRM文件中读取视频URL
    let videoUrl = null;
    try {
      if (song.filepath && fs.existsSync(song.filepath)) {
        const strmContent = fs.readFileSync(song.filepath, 'utf8').trim();
        // STRM内容是 http://127.0.0.1:8080/api/cloud/stream-path/...
        // 转换为相对路径 /api/cloud/stream-path/...
        const match = strmContent.match(/\/api\/cloud\/stream-path\/.+$/);
        if (match) {
          videoUrl = match[0];
        } else {
          videoUrl = strmContent;
        }
      }
    } catch (e) {
      console.error('[SEP-INFO] 读取MKV STRM失败:', e.message);
    }
    // 使用代理模式（?proxy=1）：服务端带上115专用User-Agent转发流
    // 解决tvOS AVPlayer请求115直链时无正确UA导致403的问题
    if (videoUrl && !videoUrl.includes('?proxy=')) {
      videoUrl += (videoUrl.includes('?') ? '&' : '?') + 'proxy=1';
    }
    return res.json({
      dual: false,
      hasVocal: true,
      hasAccomp: true,
      sepStatus: 'done',
      videoUrl: videoUrl,
      isNetKtvMkv: true,
      isVideo: true,
      audioTracks: song.audio_tracks || 2,
    });
  }

  // 网络KTV歌曲（115网盘双FLAC）：直接返回netktv串流代理地址
  if (song.source_root === 'netktv' || song.is_network === 1) {
    // 从vocal_path的STRM文件名中提取netktv ID
    let netktvId = null;
    if (song.vocal_path) {
      const match = String(song.vocal_path).match(/([a-f0-9]{16})_vocals\.strm/i);
      if (match) netktvId = match[1];
    }
    if (netktvId) {
      return res.json({
        dual: true,
        hasVocal: true,
        hasAccomp: true,
        sepStatus: 'done',
        vocalUrl: `/api/netktv/stream/${netktvId}/vocals`,
        accompUrl: `/api/netktv/stream/${netktvId}/accompaniment`,
        isNetKtv: true,
      });
    }
  }

  const v = resolveSepTrackFile(song, 'vocal');
  const a = resolveSepTrackFile(song, 'accomp');
  res.json({
    dual: !!(v && a),
    hasVocal: !!v,
    hasAccomp: !!a,
    sepStatus: song.sep_status || null,
    vocalUrl: v ? `/api/songs/${id}/sep-track?kind=vocal` : null,
    accompUrl: a ? `/api/songs/${id}/sep-track?kind=accomp` : null,
  });
});

// GET /api/songs/:id/sep-track?kind=vocal|accomp —— 分轨直出（Range/206，flac/wav 自适应）
app.get('/api/songs/:id/sep-track', (req, res) => {
  const song = db.prepare('SELECT * FROM songs WHERE id=?').get(parseInt(req.params.id, 10));
  if (!song) return res.status(404).end();
  const kind = req.query.kind === 'vocal' ? 'vocal' : 'accomp';
  const f = resolveSepTrackFile(song, kind);
  if (!f) return res.status(404).end();
  sendFileWithRange(req, res, f.abs, f.ext === 'flac' ? 'audio/flac' : 'audio/wav');
});

// ==================== 曲库元数据可移植快照（免重复扫描） ====================
// 导出当前整张曲库为快照（下载到本地备份）
app.get('/api/admin/catalog/export', requireAdminAuth, (req, res) => {
  const cat = catalog.exportCatalog(db, getLibraryRoots());
  res.setHeader('Content-Disposition', 'attachment; filename="momo-catalog.json"');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(cat));
});
// 把快照写到每个曲库来源根目录(跟歌曲放一起) + /data 留底，方便拷贝/新机取用
app.post('/api/admin/catalog/write-files', requireAdminAuth, (req, res) => {
  try {
    const r = catalog.writeCatalogFiles(db, getLibraryRoots(), process.env.DATA_DIR || '/data');
    log.info('CATALOG', `曲库快照已写出 ${r.count} 首 -> ${r.written.join(' , ')}`);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
const catalogUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 * 1024, files: 1 } });
function parseCatalogBody(req) {
  if (req.file && req.file.buffer) return JSON.parse(req.file.buffer.toString('utf8'));
  if (req.body && req.body.catalog) return typeof req.body.catalog === 'string' ? JSON.parse(req.body.catalog) : req.body.catalog;
  return req.body; // 直接把整个 JSON body 当快照
}
// 预览快照里的来源根能映射到本机哪个根（真正导入前确认，缺根会明确列出）
app.post('/api/admin/catalog/preview', requireAdminAuth, catalogUpload.single('catalog'), (req, res) => {
  try {
    const cat = parseCatalogBody(req);
    res.json({ count: cat.songs.length, roots: catalog.previewRootMatch(cat, getLibraryRoots(), req.body.rootMap || {}) });
  } catch (e) { res.status(400).json({ error: '快照解析失败: ' + e.message }); }
});
// 导入快照：不做 ffprobe，直接恢复元数据；rootMap 可指定 {快照根: 本机根}
app.post('/api/admin/catalog/import', requireAdminAuth, catalogUpload.single('catalog'), (req, res) => {
  try {
    const cat = parseCatalogBody(req);
    let rootMap = {}; try { rootMap = JSON.parse(req.body.rootMap || '{}'); } catch (e) { rootMap = {}; }
    const r = catalog.importCatalog(db, cat, { roots: getLibraryRoots(), rootMap, updateExisting: req.body.updateExisting !== 'false' });
    try { syncSongArtists(); } catch (e) {}
    log.info('CATALOG', `曲库快照导入完成：新增${r.added} 更新${r.updated} 跳过${r.skipped}（共${r.total}）`);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ error: '导入失败: ' + e.message }); }
});
// 新机便捷入口：快照已跟歌曲放在某来源根目录(momo-catalog.json)，直接指服务器路径导入
app.post('/api/admin/catalog/import-from-path', requireAdminAuth, (req, res) => {
  try {
    const p = String(req.body.path || '').trim();
    if (!p) return res.status(400).json({ error: '需要 path' });
    const cat = JSON.parse(fs.readFileSync(p, 'utf8'));
    const r = catalog.importCatalog(db, cat, { roots: getLibraryRoots(), rootMap: req.body.rootMap || {}, updateExisting: true });
    try { syncSongArtists(); } catch (e) {}
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ error: '导入失败: ' + e.message }); }
});

// ==================== 动态背景图片（网页遥控端上传，纯音频歌"我的图片"模式随机轮播） ====================
const BG_IMG_DIR = path.join(process.env.DATA_DIR || '/data', 'backgrounds');
const BG_IMG_RE = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
function listBgImages() {
  try { fs.mkdirSync(BG_IMG_DIR, { recursive: true }); return fs.readdirSync(BG_IMG_DIR).filter(f => BG_IMG_RE.test(f)).sort(); }
  catch (e) { return []; }
}
app.get('/api/backgrounds/images', (req, res) => {
  res.json({ images: listBgImages().map(name => ({ name, url: '/bg-images/' + encodeURIComponent(name) })) });
});
const bgUpload = multer({
  storage: multer.diskStorage({
    destination: (req, f, cb) => { try { fs.mkdirSync(BG_IMG_DIR, { recursive: true }); } catch (e) {} cb(null, BG_IMG_DIR); },
    filename: (req, f, cb) => { const ext = (path.extname(f.originalname) || '.jpg').toLowerCase().match(/^\.[a-z0-9]+$/)?.[0] || '.jpg';
      cb(null, 'bg_' + Date.now() + '_' + Math.floor(Math.random() * 1e4) + ext); },
  }),
  limits: { fileSize: 20 * 1024 * 1024, files: 12 },
});
app.post('/api/backgrounds/upload', bgUpload.array('images', 12), (req, res) => {
  const files = (req.files || []).map(f => ({ name: f.filename, url: '/bg-images/' + encodeURIComponent(f.filename) }));
  log.info('BG', `网页端上传动态背景图 ${files.length} 张`);
  res.json({ ok: true, images: files });
});
app.delete('/api/backgrounds/images/:name', (req, res) => {
  const name = path.basename(req.params.name || ''); // basename 防目录穿越
  if (!BG_IMG_RE.test(name)) return res.status(400).json({ error: '非法文件名' });
  try { fs.unlinkSync(path.join(BG_IMG_DIR, name)); res.json({ ok: true }); }
  catch (e) { res.status(404).json({ error: e.message }); }
});

// GET /api/songs/:id/source —— worker 下载待处理源音频。普通文件原样下发；CUE 分轨
// 用 ffmpeg 按 start/end_offset 实时截取为 44.1k 立体声 wav 流（Demucs 需无损整段）。
app.get('/api/songs/:id/source', (req, res) => {
  const song = db.prepare('SELECT * FROM songs WHERE id=?').get(parseInt(req.params.id, 10));
  if (!song) return res.status(404).json({ error: 'song not found' });
  const cached = (song.is_network && song.cache_status === 'ready' && song.cache_path) ? song.cache_path : null;
  let src = song.media_type === 'cue' && song.cue_path ? song.cue_path : (cached || song.filepath);
  if (!src || !fs.existsSync(src)) return res.status(404).json({ error: '源文件在服务端不可达', path: src });
  if (song.media_type === 'cue') {
    const start = Number(song.start_offset) || 0;
    const end = Number(song.end_offset);
    const args = ['-loglevel', 'error', '-ss', String(start)];
    if (end && end > start) args.push('-t', String(end - start));
    args.push('-i', src, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1');
    res.setHeader('Content-Type', 'audio/wav');
    const child = spawn('ffmpeg', args);
    child.stdout.pipe(res);
    child.stderr.on('data', () => { /* 丢弃 ffmpeg 进度噪音 */ });
    res.on('close', () => child.kill('SIGKILL'));
  } else {
    // 普通音频文件：走 sendFileWithRange（支持 Range/206、Accept-Ranges、Cache-Control），
    // 让 TV 端 <audio> 能边下边播、拖动进度条寻址，而不是每次从头下载整首。
    const ext = (path.extname(src) || '').toLowerCase();
    const mime = ext === '.flac' ? 'audio/flac'
      : ext === '.wav' ? 'audio/wav'
      : ext === '.mp3' ? 'audio/mpeg'
      : ext === '.m4a' ? 'audio/mp4'
      : ext === '.ogg' ? 'audio/ogg'
      : 'application/octet-stream';
    sendFileWithRange(req, res, src, mime);
  }
});

app.get('/api/songs', (req, res) => {
  const q = (req.query.q || '').trim();
  const artist = (req.query.artist || '').trim();
  // incomplete 用于「曲库管理」筛选未填写完整信息的歌曲：
  //   language - 缺语种　genre - 缺风格　artist - 歌手未知/未填
  //   any      - 以上三项任意一项缺失
  const incomplete = (req.query.incomplete || '').trim();
  // scope 用于「曲库管理」的"本地曲库 / 网络曲库"切换显示：不传或传其它
  // 值都视为"全部"，只有 local/network 会真正加限制条件，跟其它筛选条件
  // (搜索关键字、incomplete)是"且"的关系，可以叠加使用。
  const scope = (req.query.scope || '').trim();
  // [临时测试] 默认只返回网络KTV歌曲，测试完成后改回 ''
  const scopeClause = scope === 'local' ? 'is_network = 0'
    : scope === 'network' ? 'is_network = 1'
    : 'is_network = 1';

  const pageRaw = parseInt(req.query.page, 10);
  const pageSizeRaw = parseInt(req.query.pageSize, 10);
  const paginate = Number.isInteger(pageRaw) && pageRaw > 0 && Number.isInteger(pageSizeRaw) && pageSizeRaw > 0;
  const page = paginate ? pageRaw : 1;
  const pageSize = paginate ? Math.min(pageSizeRaw, 500) : 0;

  let baseSql, countSql, params = [];

  if (artist) {
    // 按歌手精确查找：一首歌可能有多位歌手（合唱），不能直接对
    // songs.artist 整段字符串做等值比较（那样会漏掉"刀郎 张三"这类多歌手
    // 曲目在只点开"刀郎"时应该出现的情况），改成走 song_artists 关联表。
    let where = 'sa.artist = ?';
    params = [artist];
    if (scopeClause) where += ` AND s.${scopeClause}`;
    baseSql = `SELECT s.* FROM songs s JOIN song_artists sa ON sa.song_id = s.id WHERE ${where} ORDER BY s.title`;
    countSql = `SELECT COUNT(*) c FROM songs s JOIN song_artists sa ON sa.song_id = s.id WHERE ${where}`;
  } else if (incomplete) {
    const conditions = {
      language: "(language IS NULL OR language = '')",
      genre: "(genre IS NULL OR genre = '')",
      artist: "(artist IS NULL OR artist = '' OR artist = '未知歌手')",
      // 音轨探测未成功(NULL)或者是单音轨(=1，播放时走"声道型"原/伴唱分离，
      // 准确率不如真正的双音轨)——两者都是管理员可能想挑出来复查、手动重探
      // 或确认这首歌本来就是单音轨的情况，合并成一个筛选项，不计入"any"
      // (any 只统计歌手/语种/风格这类文字信息是否完整，跟音轨探测无关)。
      track: '(audio_tracks IS NULL OR audio_tracks = 1)',
    };
    const clause = incomplete === 'any'
      ? `${conditions.language} OR ${conditions.genre} OR ${conditions.artist}`
      : conditions[incomplete];
    if (!clause) {
      return res.json(paginate ? { items: [], total: 0, page, pageSize, totalPages: 0 } : []);
    }
    let where = `(${clause})`;
    if (q) {
      where += ' AND (title LIKE ? OR artist LIKE ?)';
      params.push(`%${q}%`, `%${q}%`);
    }
    if (scopeClause) where += ` AND ${scopeClause}`;
    baseSql = `SELECT * FROM songs WHERE ${where} ORDER BY id DESC`;
    countSql = `SELECT COUNT(*) c FROM songs WHERE ${where}`;
  } else if (q || scopeClause) {
    // 播放次数相同时(尤其是大量新歌都还是 0 次)，按 id DESC 做次级排序让
    // 新入库的歌排在前面，跟下面"不带任何筛选条件"的默认排序逻辑保持一致，
    // 不然次级顺序会退化成 SQLite 未定义的物理行序，新歌搜索出来可能反而
    // 排在很后面。
    let where = '1=1';
    if (q) {
      where += ' AND (title LIKE ? OR artist LIKE ?)';
      params.push(`%${q}%`, `%${q}%`);
    }
    if (scopeClause) where += ` AND ${scopeClause}`;
    baseSql = `SELECT * FROM songs WHERE ${where} ORDER BY play_count DESC, id DESC`;
    countSql = `SELECT COUNT(*) c FROM songs WHERE ${where}`;
    // 非分页调用（TV 端/手机端的即时搜索）保留原来 LIMIT 100 的上限，避免
    // 输入很短的关键字时一次性拉回过多结果；分页调用交给下面的 LIMIT/OFFSET。
    if (!paginate) baseSql += ' LIMIT 100';
  } else {
    baseSql = `SELECT * FROM songs ORDER BY play_count DESC, id DESC`;
    countSql = `SELECT COUNT(*) c FROM songs`;
  }

  if (!paginate) {
    return res.json(db.prepare(baseSql).all(...params));
  }

  const total = db.prepare(countSql).get(...params).c;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const offset = (Math.min(page, totalPages) - 1) * pageSize;
  const items = db.prepare(`${baseSql} LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
  res.json({ items, total, page, pageSize, totalPages });
});

// 最新入库：直接按 id 降序取前 N 首，避免拉回全部歌曲再排序导致的大数据量/解析失败
app.get('/api/songs/newest', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  try {
    const rows = db.prepare('SELECT * FROM songs ORDER BY id DESC LIMIT ?').all(limit);
    res.json(rows);
  } catch (e) {
    console.error('[newest] error:', e.message);
    res.json([]);
  }
});

// 按首字母搜索
app.get('/api/songs/letter/:letter', (req, res) => {
  const letter = req.params.letter.toUpperCase();
  const rows = db.prepare('SELECT * FROM songs WHERE UPPER(SUBSTR(title,1,1)) = ? ORDER BY title LIMIT 100').all(letter);
  res.json(rows);
});

// 需求(MV加载动画下方显示下载速度/预计等待时长)：网络曲库(网盘/STRM)点歌
// 后，播放前要先把源文件缓存到本地(见 sourceCache.js)，这一步网速慢的时候
// 可能要等不短的时间——TV/手机端播放页在"加载中"转圈期间轮询这个接口，
// 拿到实时的下载速度/预计剩余时间展示给用户看，而不是让用户对着转圈干等、
// 猜不到还要多久、以为是卡死了。公开接口(不需要管理员登录)：播放页面本身
// 就是公开可访问的，跟 /api/songs、/hls 等接口的开放程度保持一致。
// 本地曲库(is_network=0 且 is_strm=0)的歌不存在"下载到本地"这一步，直接
// 返回 status:'local'，前端据此不展示下载速度/预计等待这部分UI。
app.get('/api/songs/:id/cache-progress', (req, res) => {
  const song = db.prepare('SELECT id, is_network, is_strm, cache_status FROM songs WHERE id = ?').get(req.params.id);
  if (!song) return res.status(404).json({ error: '歌曲不存在' });
  if (!song.is_network && !song.is_strm) {
    return res.json({ status: 'local', active: false, bytesCopied: null, totalBytes: null, speedBps: 0, etaSeconds: null });
  }
  const progress = sourceCache.getCacheProgress(song.id);
  res.json({ status: song.cache_status || 'none', ...progress });
});

// ---------- 歌手头像 ----------
// 头像图片由用户自行放进 SINGER_DIR（默认 /singer，对应宿主机
// /vol1/@appshare/momo-ktv/singer），文件名（不含后缀）需与歌手名完全一致，
// 如"刀郎.jpg"、"周杰伦.png"，大小写敏感（Linux 文件系统本身如此）。命中就
// 显示头像图片，没有对应文件的歌手继续沿用原有的"姓名首字+纯色背景"兜底
// 展示，不强制要求每个歌手都配图。
// 这个目录是独立于 MV_DIR 的可选功能目录：即使完全不放任何文件，应用也要
// 能正常工作（目录不存在/为空时，下面的扫描直接兜底成一张空表，不影响
// /api/artists 正常返回，只是所有歌手都没有头像而已）。
const SINGER_DIR = process.env.SINGER_DIR || '/singer';
const SINGER_AVATAR_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
// 目录扫描结果做一层短 TTL 缓存：歌手列表接口访问频率不低（每次打开"歌星"
// 页签都会触发），但头像文件本身几乎不会频繁变动，没必要每次请求都做一次
// 同步 readdir；缓存 30 秒既保证用户新增/替换头像后很快就能在前台看到，
// 又避免了不必要的磁盘 IO。
let singerAvatarCache = null; // Map: 歌手名(不含后缀) -> 实际文件名(含后缀)
let singerAvatarCacheAt = 0;
const SINGER_AVATAR_CACHE_TTL = 30 * 1000;

function getSingerAvatarMap() {
  const now = Date.now();
  if (singerAvatarCache && (now - singerAvatarCacheAt) < SINGER_AVATAR_CACHE_TTL) {
    return singerAvatarCache;
  }
  const map = new Map();
  try {
    const files = fs.readdirSync(SINGER_DIR);
    for (const f of files) {
      const ext = path.extname(f).toLowerCase();
      if (!SINGER_AVATAR_EXTS.includes(ext)) continue;
      map.set(path.basename(f, path.extname(f)), f);
    }
  } catch (e) {
    // 目录不存在（比如用户还没在共享文件夹里建 singer 子目录）或不可读时，
    // 视为"没有任何歌手头像"，全部歌手继续走首字头像兜底，不影响其它功能。
  }
  singerAvatarCache = map;
  singerAvatarCacheAt = now;
  return map;
}

// 头像图片直出接口：按歌手名查缓存里记录的真实文件名再拼路径读取，不直接
// 拿前端传来的原始字符串去拼文件系统路径，避免路径穿越；命中才 200，没有
// 对应头像时返回 404，前端据此决定是否回退到首字头像。
app.get('/api/singer-avatar/:artist', (req, res) => {
  const file = getSingerAvatarMap().get(req.params.artist);
  if (!file) return res.status(404).end();
  const filePath = path.resolve(SINGER_DIR, file);
  if (!filePath.startsWith(path.resolve(SINGER_DIR) + path.sep)) return res.status(400).end();
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// 需求：管理端新增"扫描歌手头像"这个手动触发入口——头像本来就是每次请求
// 自动带 30 秒 TTL 缓存刷新的(见上面 getSingerAvatarMap 的注释)，理论上不用
// 手动扫描也能自动生效，但管理员往共享文件夹里新丢了一批头像图片后，往往
// 想立刻看到"识别到了几个"这个确认反馈，而不是模糊地等最多 30 秒、也不知道
// 到底有没有生效。这个接口把缓存直接清空强制重新读一次目录，返回命中数量，
// 跟"扫描曲库"一样给一次明确的结果反馈。
app.post('/api/admin/rescan-avatars', requireAdminAuth, (req, res) => {
  singerAvatarCache = null;
  singerAvatarCacheAt = 0;
  const map = getSingerAvatarMap();
  res.json({ ok: true, count: map.size });
});


// 按 song_artists 关联表分组，而不是直接对 songs.artist 整段字符串分组——
// 这样"刀郎 张三"这类合唱曲目会让刀郎、张三分别出现在歌手列表里、分别计入
// 各自的曲目数，而不是被当成一个奇怪的组合歌手名整体展示。
// 分页支持(需求"歌手列表也支持真正的服务端分页，和点歌列表加载逻辑相同")：
// 跟 /api/songs 同一套约定——只有请求显式带上 page & pageSize 时才走分页分支，
// 返回 { items, total, page, pageSize, totalPages } 带元信息的对象；不带分页
// 参数时仍然和以前一样直接返回数组(手机端/老版本客户端还在用)，完全向后兼容。
app.get('/api/artists', (req, res) => {
  const pageRaw = parseInt(req.query.page, 10);
  const pageSizeRaw = parseInt(req.query.pageSize, 10);
  const paginate = Number.isInteger(pageRaw) && pageRaw > 0 && Number.isInteger(pageSizeRaw) && pageSizeRaw > 0;
  const page = paginate ? pageRaw : 1;
  const pageSize = paginate ? Math.min(pageSizeRaw, 500) : 0;

  const rows = db.prepare(`
    SELECT artist, COUNT(*) as count
    FROM song_artists
    GROUP BY artist
    ORDER BY artist
  `).all();
  // 附带 hasAvatar 标记，前端据此决定渲染头像图片还是首字兜底，不用再为
  // 每个歌手单独发一次请求去探测头像是否存在。
  const avatarMap = getSingerAvatarMap();
  const withAvatar = r => ({ ...r, hasAvatar: avatarMap.has(r.artist) });

  if (!paginate) {
    return res.json(rows.map(withAvatar));
  }
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const offset = (Math.min(page, totalPages) - 1) * pageSize;
  const items = rows.slice(offset, offset + pageSize).map(withAvatar);
  res.json({ items, total, page, pageSize, totalPages });
});

// ---------- 历史 (常唱) ----------
app.get('/api/history', (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, COUNT(h.id) as times_sung
    FROM songs s JOIN history h ON s.id = h.song_id
    GROUP BY s.id ORDER BY times_sung DESC, s.play_count DESC LIMIT 50
  `).all();
  res.json(rows);
});

// ---------- 爱唱榜 (按播放次数) ----------
app.get('/api/charts', (req, res) => {
  const rows = db.prepare('SELECT * FROM songs WHERE play_count > 0 ORDER BY play_count DESC LIMIT 50').all();
  res.json(rows);
});

// ---------- 收藏 ----------
app.get('/api/favorites', (req, res) => {
  const device = req.query.device || 'default';
  const rows = db.prepare(`
    SELECT s.* FROM songs s
    JOIN favorites f ON s.id = f.song_id
    WHERE f.device_id = ? ORDER BY f.created_at DESC
  `).all(device);
  res.json(rows);
});

app.post('/api/favorites/:song_id', (req, res) => {
  const device = req.body.device || 'default';
  db.prepare('INSERT OR IGNORE INTO favorites (song_id, device_id) VALUES (?,?)').run(req.params.song_id, device);
  res.json({ ok: true });
});

app.delete('/api/favorites/:song_id', (req, res) => {
  const device = req.query.device || 'default';
  db.prepare('DELETE FROM favorites WHERE song_id = ? AND device_id = ?').run(req.params.song_id, device);
  res.json({ ok: true });
});

// ---------- 语种 / 风格自定义预设 ----------
// 「曲库管理」里语种、风格两个字段允许管理员自己维护一份常用取值列表
// （比如"国语/粤语/英语"、"流行/摇滚/民谣"），保存进 settings 表
// （key = preset_languages / preset_genres，值是 JSON 数组字符串），
// 跟随 /data 持久化，升级、容器重建都不受影响。前台的语种/风格列既用
// 它做下拉可选项，也用来支撑"多选歌曲、一键设置语种和风格"的批量操作。
// 首次使用时还没有任何预设，给一组常见默认值方便直接用，之后管理员增删
// 都基于这份列表继续调整，不会每次都被默认值覆盖。
const PRESET_LANGUAGE_KEY = 'preset_languages';
const PRESET_GENRE_KEY = 'preset_genres';
const DEFAULT_PRESET_LANGUAGES = ['国语', '粤语', '英语', '日语', '韩语', '其他'];
const DEFAULT_PRESET_GENRES = ['流行', '摇滚', '民谣', '伤感', '怀旧', '说唱', '电子', '其他'];

// 「曲库管理 - 一键清洗」里管理员自定义的忽略词列表：常见于画质/平台版本
// 一类跟"这首歌真正叫什么"无关的标记，命中就整体从标题里摘掉。存储方式、
// 持久化方式跟语种/风格预设完全一样（同一张 settings 表，同一套增删接口，
// 见下面 presetKeyFallback 里的 'noise' 分支），管理员可以照着自己曲库里
// 实际出现过的标记自行增删，这里只给一组常见默认值方便直接用。
const CLEAN_NOISE_KEY = 'clean_noise_words';
const DEFAULT_NOISE_WORDS = ['1080p', '720p', '4K', '高清', '抖音版', 'live', '现场版', '伴奏'];

function getPresetList(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback.slice();
  try {
    const arr = JSON.parse(row.value);
    return Array.isArray(arr) ? arr : fallback.slice();
  } catch (e) {
    return fallback.slice();
  }
}
function setPresetList(key, list) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(list));
}
function presetKeyFallback(type) {
  if (type === 'genre') return { key: PRESET_GENRE_KEY, fallback: DEFAULT_PRESET_GENRES };
  if (type === 'language') return { key: PRESET_LANGUAGE_KEY, fallback: DEFAULT_PRESET_LANGUAGES };
  if (type === 'noise') return { key: CLEAN_NOISE_KEY, fallback: DEFAULT_NOISE_WORDS };
  return null;
}
function presetTypeName(type) {
  if (type === 'genre') return '风格';
  if (type === 'noise') return '忽略词';
  return '语种';
}

app.get('/api/admin/presets', requireAdminAuth, (req, res) => {
  res.json({
    languages: getPresetList(PRESET_LANGUAGE_KEY, DEFAULT_PRESET_LANGUAGES),
    genres: getPresetList(PRESET_GENRE_KEY, DEFAULT_PRESET_GENRES),
    noiseWords: getPresetList(CLEAN_NOISE_KEY, DEFAULT_NOISE_WORDS),
  });
});

app.post('/api/admin/presets', requireAdminAuth, (req, res) => {
  const { type, value } = req.body || {};
  const v = String(value || '').trim();
  if (!v) return res.status(400).json({ error: '预设内容不能为空' });
  if (v.length > 20) return res.status(400).json({ error: '预设内容最多 20 个字符' });
  const kf = presetKeyFallback(type);
  if (!kf) return res.status(400).json({ error: '类型不正确，应为 language / genre / noise' });
  const list = getPresetList(kf.key, kf.fallback);
  if (!list.includes(v)) list.push(v);
  setPresetList(kf.key, list);
  log.info('ADMIN', `新增${presetTypeName(type)}预设: ${v}`);
  res.json({ ok: true, list });
});

app.delete('/api/admin/presets', requireAdminAuth, (req, res) => {
  const type = String(req.query.type || '').trim();
  const value = String(req.query.value || '').trim();
  const kf = presetKeyFallback(type);
  if (!kf || !value) return res.status(400).json({ error: '参数不正确' });
  const list = getPresetList(kf.key, kf.fallback).filter(x => x !== value);
  setPresetList(kf.key, list);
  log.info('ADMIN', `删除${presetTypeName(type)}预设: ${value}`);
  res.json({ ok: true, list });
});

// ---------- 文件名解析（自定义模板重新解析曲库） ----------
// 有别于 scanner.js 里固定死的"歌手-歌曲名-语种-风格"默认解析规则：这里
// 让管理员按自己曲库文件名真实的样子，自定义一套解析格式（模板语法见
// filenameTemplate.js 顶部注释），先预览重新解析后的效果，确认没问题
// 再选择"部分确认"或"全部确认"写回数据库。只影响
// title/artist/language/genre 这几个字段，不涉及扫描/入库/删除，也不会
// 碰文件本身。
const { compilePattern, parseWithTemplate, baseNameOf } = require('./filenameTemplate');
const { cleanTitle } = require('./cleaner');

// 圈定这次要预览/解析哪些歌曲：优先用「曲库管理」页面里已经勾选的歌曲
// （ids 非空），跟"批量设置语种/风格"共用同一套"已选优先"的心智模型；
// 没有勾选任何歌曲时，退回到当前的搜索关键字 / "信息不完整"筛选条件
// （跟 /api/songs 用的是同一套筛选逻辑），保证预览范围和管理员表格里
// 当前正看到的范围一致。
function matchedSongsForParse(body) {
  const { ids, q, incomplete, scope } = body || {};
  if (Array.isArray(ids) && ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM songs WHERE id IN (${placeholders}) ORDER BY id`).all(...ids);
  }
  const query = String(q || '').trim();
  const inc = String(incomplete || '').trim();
  // 跟 /api/songs 用同一套 scope 语义：曲库管理页面切到"本地曲库"/"网络
  // 曲库"时，批量工具(文件名解析/一键清洗)的圈定范围要跟表格里当前看到
  // 的一致，不然管理员会以为只处理了眼前这些，实际却处理了另一边的歌。
  const sc = String(scope || '').trim();
  let where = '1=1';
  const params = [];
  if (inc) {
    const conditions = {
      language: "(language IS NULL OR language = '')",
      genre: "(genre IS NULL OR genre = '')",
      artist: "(artist IS NULL OR artist = '' OR artist = '未知歌手')",
      track: '(audio_tracks IS NULL OR audio_tracks = 1)',
    };
    const clause = inc === 'any'
      ? `${conditions.language} OR ${conditions.genre} OR ${conditions.artist}`
      : conditions[inc];
    if (clause) where += ` AND (${clause})`;
  }
  if (query) {
    where += ' AND (title LIKE ? OR artist LIKE ?)';
    params.push(`%${query}%`, `%${query}%`);
  }
  if (sc === 'local') where += ' AND is_network = 0';
  else if (sc === 'network') where += ' AND is_network = 1';
  return db.prepare(`SELECT * FROM songs WHERE ${where} ORDER BY id DESC`).all(...params);
}

// 一次预览最多展示这么多条"命中且有变化"的结果，避免管理员一次要审核的
// 行数失控；不限制参与解析计算的歌曲数量本身（圈定范围内的歌曲都会先解析
// 一遍，只是最终展示/可确认的结果条数封顶在这里）。
const PARSE_PREVIEW_LIMIT = 300;

app.post('/api/admin/filename-parse/preview', requireAdminAuth, (req, res) => {
  const { pattern } = req.body || {};
  const presets = {
    languages: getPresetList(PRESET_LANGUAGE_KEY, DEFAULT_PRESET_LANGUAGES),
    genres: getPresetList(PRESET_GENRE_KEY, DEFAULT_PRESET_GENRES),
  };
  const compiled = compilePattern(pattern, presets);
  if (!compiled.ok) return res.status(400).json({ error: compiled.error });

  const matched = matchedSongsForParse(req.body);
  // 需求(手动忽略误命中)：跟一键清洗一样，管理员手动确认过"这首歌不用走
  // 文件名解析"的(parse_ignored=1)，直接从圈定范围里剔除，不参与本次解析
  // 计算，也不会再出现在预览列表里。
  const all = matched.filter(s => !s.parse_ignored);
  const ignoredCount = matched.length - all.length;

  // 先对圈定范围内的全部歌曲挨个解析一遍，再决定要不要展示——解析格式能
  // 不能匹配上跟这首歌在结果集里排第几名毫无关系，如果解析前就先按数据库
  // 返回顺序截断到前 PARSE_PREVIEW_LIMIT 首，会导致排得靠后、明明能正常
  // 匹配解析格式的歌曲，从一开始就没被拿去解析过，预览里自然也不会出现，
  // 只有管理员恰好用搜索/筛选把它挤进前面才能被看到（这也是"确认全部可用
  // 变更"实际只能应用一小部分的根源）。真正应该限量展示的，是"命中且有
  // 变化"这部分结果本身，而不是参与解析计算的歌曲数量。
  let failedCount = 0;
  let noChangeCount = 0;
  const changedItems = [];
  for (const s of all) {
    const base = baseNameOf(s.filename);
    const parsed = parseWithTemplate(base, compiled);
    if (!parsed) { failedCount++; continue; }
    const current = {
      title: s.title || '',
      artist: s.artist || '',
      language: s.language || '',
      genre: s.genre || '',
    };
    const changed = parsed.title !== current.title ||
      parsed.artist !== current.artist ||
      parsed.language !== current.language ||
      parsed.genre !== current.genre;
    if (!changed) { noChangeCount++; continue; }
    changedItems.push({ id: s.id, filename: s.filename, current, parsed, changed: true });
  }

  // 到这一步才截断：只限制"命中且有变化、需要管理员逐条确认"这部分展示
  // 数量，解析失败/无需更改的行本来就不展示，只汇总数量，不受这个上限
  // 影响。
  const truncated = changedItems.length > PARSE_PREVIEW_LIMIT;
  const items = truncated ? changedItems.slice(0, PARSE_PREVIEW_LIMIT) : changedItems;

  log.info('ADMIN', `文件名解析预览: 格式="${pattern}" 圈定范围 ${all.length} 首，命中且有变化 ${changedItems.length} 首${truncated ? `（仅返回前 ${PARSE_PREVIEW_LIMIT} 首）` : ''}${ignoredCount ? `，另有 ${ignoredCount} 首已被手动忽略未参与本次` : ''}`);
  res.json({
    ok: true,
    total: all.length,
    matchedCount: changedItems.length,
    failedCount,
    noChangeCount,
    truncated,
    limit: PARSE_PREVIEW_LIMIT,
    items,
    ignoredCount,
  });
});

// 把预览里管理员确认过的结果（全部或部分勾选）写回数据库。updates 里每一
// 项就是预览结果里 parsed 字段本身，前端直接原样带回来，服务端不重新解析，
// 避免"预览时用的预设/正则"和"应用时"不一致导致结果对不上。
app.post('/api/admin/filename-parse/apply', requireAdminAuth, (req, res) => {
  const { updates } = req.body || {};
  if (!Array.isArray(updates) || !updates.length) return res.status(400).json({ error: '没有要应用的变更' });
  const upd = db.prepare('UPDATE songs SET title=?, artist=?, language=?, genre=? WHERE id=?');
  let count = 0;
  const tx = db.transaction((list) => {
    for (const u of list) {
      const title = String(u.title || '').trim();
      if (!title || !u.id) continue; // 歌名不能为空，异常行直接跳过，不写坏数据
      const artist = String(u.artist || '').trim();
      const language = String(u.language || '').trim();
      const genre = String(u.genre || '').trim();
      upd.run(title, artist, language, genre, u.id);
      syncSongArtists(u.id, artist);
      count++;
    }
  });
  tx(updates);
  log.info('ADMIN', `文件名解析结果已应用: ${count} 首`);
  res.json({ ok: true, count });
});

// 需求(文件名解析-手动忽略误命中)：跟一键清洗那一套完全对称，只是换成
// parse_ignored 字段、只影响 /api/admin/filename-parse/preview 的圈定范围。
app.post('/api/admin/filename-parse/ignore', requireAdminAuth, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: '未指定要忽略的歌曲' });
  const upd = db.prepare('UPDATE songs SET parse_ignored = 1 WHERE id = ?');
  const tx = db.transaction((list) => { for (const id of list) upd.run(id); });
  tx(ids);
  log.info('ADMIN', `文件名解析: 手动标记忽略 ${ids.length} 首（以后解析预览不再命中）`);
  res.json({ ok: true, count: ids.length });
});

app.post('/api/admin/filename-parse/unignore', requireAdminAuth, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: '未指定要取消忽略的歌曲' });
  const upd = db.prepare('UPDATE songs SET parse_ignored = 0 WHERE id = ?');
  const tx = db.transaction((list) => { for (const id of list) upd.run(id); });
  tx(ids);
  log.info('ADMIN', `文件名解析: 取消忽略 ${ids.length} 首`);
  res.json({ ok: true, count: ids.length });
});

const PARSE_IGNORED_LIST_LIMIT = 300;
app.get('/api/admin/filename-parse/ignored', requireAdminAuth, (req, res) => {
  const rows = db.prepare('SELECT id, title, filename FROM songs WHERE parse_ignored = 1 ORDER BY id DESC LIMIT ?').all(PARSE_IGNORED_LIST_LIMIT);
  const total = db.prepare('SELECT COUNT(*) c FROM songs WHERE parse_ignored = 1').get().c;
  res.json({ ok: true, items: rows, total, truncated: total > PARSE_IGNORED_LIST_LIMIT, limit: PARSE_IGNORED_LIST_LIMIT });
});

// ---------- 一键清洗（自定义忽略词 + 语种/风格关键字识别） ----------
// 跟上面的"文件名解析"是两套互补的曲库整理工具：文件名解析是"整段文件名
// 按固定模板拆成字段"，这里的一键清洗解决的是另一类更常见的脏数据——标题
// 里混进了跟歌曲本身无关的画质/平台版本标记（如"[1080p]""（抖音版）"
// "（live）"），管理员在忽略词列表里维护这些标记，一键就能把它们从标题
// 里摘掉，只留下干净的歌曲名；同时只要标题里任意位置（不要求在开头、结
// 尾或某个固定分隔符位置）命中当前语种/风格预设列表里的取值（如"国语"
// "流行"），也会顺带识别出来，同样是预览对照确认后才批量写回，不直接改
// 数据库。
app.post('/api/admin/clean/preview', requireAdminAuth, (req, res) => {
  const presets = {
    languages: getPresetList(PRESET_LANGUAGE_KEY, DEFAULT_PRESET_LANGUAGES),
    genres: getPresetList(PRESET_GENRE_KEY, DEFAULT_PRESET_GENRES),
  };
  const noiseWords = getPresetList(CLEAN_NOISE_KEY, DEFAULT_NOISE_WORDS);

  const matched = matchedSongsForParse(req.body); // 圈定范围规则跟文件名解析共用一套（已选优先，否则按当前搜索/筛选）
  // 需求(手动忽略误命中)：管理员已经手动确认过"这首歌不需要一键清洗处理"的
  // (clean_ignored=1)，直接从这一轮圈定范围里剔除，不再参与清洗识别/不会
  // 出现在预览列表里——避免同一个误命中反复出现，管理员每次预览都要重新
  // 跳过一遍。ignoredCount 单独统计，让管理员知道这次圈定范围里有多少首是
  // 被忽略掉、没有实际参与计算的，不是"漏算"。
  const all = matched.filter(s => !s.clean_ignored);
  const ignoredCount = matched.length - all.length;
  const truncated = all.length > PARSE_PREVIEW_LIMIT;
  const songs = truncated ? all.slice(0, PARSE_PREVIEW_LIMIT) : all;

  const items = songs.map(s => {
    const current = {
      title: s.title || '',
      language: s.language || '',
      genre: s.genre || '',
    };
    const result = cleanTitle(current.title, noiseWords, presets);
    // 没命中语种/风格时不覆盖数据库里原有的取值——一键清洗只负责"从标题
    // 里摘出信息"，不负责替管理员清空已经填好的字段。
    const cleaned = {
      title: result.title,
      language: result.language || current.language,
      genre: result.genre || current.genre,
    };
    const changed = cleaned.title !== current.title ||
      cleaned.language !== current.language ||
      cleaned.genre !== current.genre;
    const emptyTitle = changed && !cleaned.title;
    // 需求(误清洗兜底)：只要这次清洗里有任意一次摘除是"低置信度"(裸词紧贴
    // 着汉字，见 cleaner.js 顶部注释)，整条结果就标记为低置信度，跟
    // emptyTitle 一样不进默认勾选，交给管理员自己对照原文看一眼再决定。
    return {
      id: s.id, filename: s.filename, current, cleaned,
      removed: result.removed, changed, emptyTitle,
      lowConfidence: result.lowConfidence,
    };
  });
  log.info('ADMIN', `一键清洗预览: 共匹配 ${all.length} 首${truncated ? `（仅预览前 ${PARSE_PREVIEW_LIMIT} 首）` : ''}${ignoredCount ? `，另有 ${ignoredCount} 首已被手动忽略未参与本次` : ''}`);
  res.json({ ok: true, total: all.length, truncated, limit: PARSE_PREVIEW_LIMIT, items, ignoredCount });
});

// 把预览里管理员确认过的结果（全部或部分勾选）写回数据库；updates 里每一
// 项就是预览结果里 cleaned 字段本身，前端原样带回来，服务端不重新计算一
// 遍，避免"预览时用的忽略词/预设"和"应用时"不一致导致结果对不上。清洗
// 只影响 title/language/genre，不涉及歌手，也不碰文件本身。
app.post('/api/admin/clean/apply', requireAdminAuth, (req, res) => {
  const { updates } = req.body || {};
  if (!Array.isArray(updates) || !updates.length) return res.status(400).json({ error: '没有要应用的变更' });
  const upd = db.prepare('UPDATE songs SET title=?, language=?, genre=? WHERE id=?');
  let count = 0;
  const tx = db.transaction((list) => {
    for (const u of list) {
      const title = String(u.title || '').trim();
      if (!title || !u.id) continue; // 歌名不能为空，清洗后变成空标题的行直接跳过，不写坏数据
      const language = String(u.language || '').trim();
      const genre = String(u.genre || '').trim();
      upd.run(title, language, genre, u.id);
      count++;
    }
  });
  tx(updates);
  log.info('ADMIN', `一键清洗结果已应用: ${count} 首`);
  res.json({ ok: true, count });
});

// 需求(手动忽略误命中)：管理员在清洗预览列表里对着某一行确认"这是命中
// 错误的"，点一下就把这首歌标记为以后不再参与一键清洗识别；跟"应用清洗
// 结果"是两回事——这里完全不碰 title/language/genre，只影响以后
// /api/admin/clean/preview 圈定范围时会不会把这首歌纳入计算。
app.post('/api/admin/clean/ignore', requireAdminAuth, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: '未指定要忽略的歌曲' });
  const upd = db.prepare('UPDATE songs SET clean_ignored = 1 WHERE id = ?');
  const tx = db.transaction((list) => { for (const id of list) upd.run(id); });
  tx(ids);
  log.info('ADMIN', `一键清洗: 手动标记忽略 ${ids.length} 首（以后清洗预览不再命中）`);
  res.json({ ok: true, count: ids.length });
});

// 取消忽略：配合"已忽略"列表里的"取消忽略"按钮，让管理员在标记错了/以后
// 想重新纳入清洗范围时能撤回，不用整个重新扫描曲库。
app.post('/api/admin/clean/unignore', requireAdminAuth, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: '未指定要取消忽略的歌曲' });
  const upd = db.prepare('UPDATE songs SET clean_ignored = 0 WHERE id = ?');
  const tx = db.transaction((list) => { for (const id of list) upd.run(id); });
  tx(ids);
  log.info('ADMIN', `一键清洗: 取消忽略 ${ids.length} 首`);
  res.json({ ok: true, count: ids.length });
});

// 已忽略列表：供"一键清洗"弹窗里的"管理已忽略"面板展示，让管理员能看到
// 当前一共标记忽略了哪些歌、需要的话逐条/批量取消。跟清洗预览一样限量
// 展示，避免忽略的曲目特别多时一次性把整个列表撑爆。
const CLEAN_IGNORED_LIST_LIMIT = 300;
app.get('/api/admin/clean/ignored', requireAdminAuth, (req, res) => {
  const rows = db.prepare('SELECT id, title, filename FROM songs WHERE clean_ignored = 1 ORDER BY id DESC LIMIT ?').all(CLEAN_IGNORED_LIST_LIMIT);
  const total = db.prepare('SELECT COUNT(*) c FROM songs WHERE clean_ignored = 1').get().c;
  res.json({ ok: true, items: rows, total, truncated: total > CLEAN_IGNORED_LIST_LIMIT, limit: CLEAN_IGNORED_LIST_LIMIT });
});

// ---------- 歌曲管理 (Admin) ----------
// 只有这几个真正的"增删改"动作要求登录；/api/scan、/api/songs 等电视端、
// 手机点歌页面共用的接口保持开放，见文件顶部「曲库管理管理员登录」的说明。
//
// 批量设置语种/风格：配合曲库管理页面"多选歌曲 + 一键设置"，一次请求对
// 多首歌曲生效，避免逐首打开编辑弹窗手动填。setLanguage/setGenre 两个
// 标志位分别控制"这次请求要不要动语种/风格这个字段"——只勾选了语种时，
// 请求里即使没带 genre 也不会误清空所有选中歌曲的风格，反之亦然。路由
// 必须写在 "/api/songs/:id" 之前，否则 "batch" 会被当成 :id 的取值。
app.put('/api/songs/batch', requireAdminAuth, (req, res) => {
  const { ids, language, genre, setLanguage, setGenre } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: '未选择歌曲' });
  if (!setLanguage && !setGenre) return res.status(400).json({ error: '未指定要设置的字段' });
  const lang = (language || '').trim();
  const gen = (genre || '').trim();
  const tx = db.transaction((idList) => {
    for (const id of idList) {
      if (setLanguage && setGenre) {
        db.prepare('UPDATE songs SET language=?, genre=? WHERE id=?').run(lang, gen, id);
      } else if (setLanguage) {
        db.prepare('UPDATE songs SET language=? WHERE id=?').run(lang, id);
      } else if (setGenre) {
        db.prepare('UPDATE songs SET genre=? WHERE id=?').run(gen, id);
      }
    }
  });
  tx(ids);
  log.info('ADMIN', `批量设置 ${ids.length} 首歌曲: ${setLanguage ? `语种="${lang}" ` : ''}${setGenre ? `风格="${gen}"` : ''}`);
  res.json({ ok: true, count: ids.length });
});

// Bug修复(问题3 "曲库删不掉/数量对不上"的第一部分)：原来这里只删了
// song_artists 就直接删 songs，完全没清 queue/history/favorites——queue 表
// 对 songs.id 有真实的 FOREIGN KEY 约束，只要这首歌被点过一次(哪怕已经
// 播完，queue 记录也只会被标 status='done'、从不真删)，这里就会撞上
// "FOREIGN KEY constraint failed"，删除直接失败。改成统一调用
// scanner.js 的 deleteSongCascade()，跟扫描时的自动清理走同一套级联删除
// 逻辑，不会再出现"扫描能清、管理员手动删不掉"这种不一致。
app.delete('/api/songs/:id', requireAdminAuth, (req, res) => {
  try {
    deleteSongCascade(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    log.error('ADMIN', `删除歌曲失败(id=${req.params.id}): ${e.message}`);
    res.status(500).json({ error: '删除失败: ' + e.message });
  }
});

// 歌名统一规范为"歌手-歌曲名-语种-风格"，这里同时接收 language/genre；
// artist 允许填写多位歌手（用空格分隔，和文件名的约定保持一致），保存后
// 立即调用 syncSongArtists 重新同步 song_artists 关联表，让"歌手列表"里
// 每一位歌手都能分别展示、分别按歌手查到这首歌（包括合唱曲目）。
app.put('/api/songs/:id', requireAdminAuth, (req, res) => {
  const id = req.params.id;
  const title = (req.body.title || '').trim();
  const artist = (req.body.artist || '').trim();
  const language = (req.body.language || '').trim();
  const genre = (req.body.genre || '').trim();
  db.prepare('UPDATE songs SET title=?, artist=?, language=?, genre=? WHERE id=?')
    .run(title, artist, language, genre, id);
  syncSongArtists(id, artist);
  res.json({ ok: true });
});

// 单曲重新探测音轨：跟 /api/scan 的 resetAudioTracks 是同一个"探测失败被
// 永久误判为单音轨"问题的另一种修复入口——那个是"整库清空重新探测"，一次
// 要把所有歌曲(包括探测本来就正确的)重新探测一遍，曲库大的话很费时间；
// 这里给一首歌单独重新探测一次，确认某一首有问题时只动这一首，不影响
// 其余已经探测正确的曲目，也不需要跟着走一次完整扫描。
// Bug修复(问题2 "点重新探测音轨直接报错"及其暴露的第二个bug)：原来这里
// 直接对 song.filepath 跑 probeAudioTracks()——既没 await(拿到的是还没
// resolve 的 Promise，直接塞给 SQLite 绑定参数会报
// "TypeError: SQLite3 can only bind numbers, strings, bigints, buffers, and
// null")，也没走 STRM/网络挂载该走的"先解析真实源地址、落地缓存"这一步
// (直接对 .strm 指针文件跑 ffprobe，必然 "Invalid data found when
// processing input")。改成统一调用 scanner.js 的 ensureProbedOnDemand()，
// 传 force=true 无视已有的 audio_tracks 值、强制重新走一遍完整流程。
app.post('/api/songs/:id/reprobe-audio-tracks', requireAdminAuth, async (req, res) => {
  const song = db.prepare('SELECT id, title, artist, filepath, is_network, is_strm, audio_tracks FROM songs WHERE id = ?').get(req.params.id);
  if (!song) return res.status(404).json({ error: '歌曲不存在' });
  try {
    const audio_tracks = await ensureProbedOnDemand(song, true);
    log.info('SCAN', `管理员触发：单曲重新探测音轨 [歌曲 id=${song.id} "${song.title}"] -> ${audio_tracks == null ? '探测失败，已标记待下次扫描重试' : audio_tracks + ' 条'}`);
    res.json({ ok: true, audio_tracks });
  } catch (e) {
    log.error('SCAN', `管理员触发：单曲重新探测音轨失败 [歌曲 id=${song.id} "${song.title}"]: ${e.message}`);
    res.status(500).json({ error: '重新探测失败: ' + e.message });
  }
});

// 批量重新探测音轨：配合曲库管理页面"多选歌曲 + 批量重探音轨"，一次对多首
// 歌曲分别重新探测一遍，跟单曲的 /api/songs/:id/reprobe-audio-tracks 是同一
// 个探测函数，区别只是一次处理一批 id。逐首探测之间让出一次事件循环（跟
// scanner.js 的 yieldToEventLoop 同样的考虑），避免一次性勾选很多首时长时间
// 阻塞其它请求；单首探测失败（比如文件恰好被移走）只记日志跳过，不影响
// 其余歌曲继续探测。
app.post('/api/songs/batch-reprobe-audio-tracks', requireAdminAuth, async (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: '未选择歌曲' });
  const results = [];
  for (const id of ids) {
    try {
      const song = db.prepare('SELECT id, title, filepath, is_network, is_strm, audio_tracks FROM songs WHERE id = ?').get(id);
      if (!song) continue;
      // 同单曲重探的修复：统一走 ensureProbedOnDemand(force=true)，不再直接
      // 对 filepath 跑未 await 的 probeAudioTracks()。
      const audio_tracks = await ensureProbedOnDemand(song, true);
      results.push({ id: song.id, audio_tracks });
    } catch (e) {
      log.error('SCAN', `批量重探音轨-单曲失败(id=${id}): ${e.message}`);
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  log.info('SCAN', `管理员触发：批量重新探测音轨，共 ${results.length} 首`);
  res.json({ ok: true, results });
});

// ---------- 曲库缓存清理 ----------
// 配合「曲库管理」页面的"清理缓存"按钮：管理员可以在两种策略间选择——
// 按存储空间限额清理（超出限额时按点歌时间从早到晚清理，直到降回限额内）
// 或按点歌时间清理（超过设定天数没被点唱过的缓存自动清理），具体清理逻辑
// 见 cacheCleaner.js。这里只负责暴露设置的读写、当前缓存占用的统计，以及
// 手动触发一次清理这三个接口，全部要求管理员登录。
function validSongIds() {
  return db.prepare('SELECT id FROM songs').all().map(r => r.id);
}

app.get('/api/admin/cache/settings', requireAdminAuth, (req, res) => {
  res.json({ ok: true, ...cacheCleaner.getSettings() });
});

app.post('/api/admin/cache/settings', requireAdminAuth, (req, res) => {
  const { mode, sizeLimitMB, timeDays } = req.body || {};
  if (mode !== 'size' && mode !== 'time') return res.status(400).json({ error: '清理方式应为"size"(按存储空间)或"time"(按点歌时间)' });
  if (mode === 'size' && !(Number(sizeLimitMB) > 0)) return res.status(400).json({ error: '请填写有效的存储空间限额(MB)' });
  if (mode === 'time' && !(Number(timeDays) > 0)) return res.status(400).json({ error: '请填写有效的保留天数' });
  const saved = cacheCleaner.saveSettings({ mode, sizeLimitMB: Number(sizeLimitMB), timeDays: Number(timeDays) });
  log.info('ADMIN', `缓存清理策略已更新: ${mode === 'size' ? `按存储空间限额 ${saved.sizeLimitMB}MB` : `按点歌时间 ${saved.timeDays} 天`}`);
  res.json({ ok: true, ...saved });
});

app.get('/api/admin/cache/stats', requireAdminAuth, (req, res) => {
  res.json({ ok: true, ...cacheCleaner.getStats() });
});

app.post('/api/admin/cache/clean', requireAdminAuth, (req, res) => {
  try {
    const result = cacheCleaner.runCleanup(validSongIds);
    const totalRemoved = result.removed + result.orphan.removed;
    const totalFreed = result.freed + result.orphan.freed;
    log.info('ADMIN', `管理员手动触发缓存清理: 方式=${result.mode === 'size' ? '存储空间限额' : '点歌时间'}，共清理 ${totalRemoved} 个(含孤儿缓存 ${result.orphan.removed} 个)，释放约 ${(totalFreed / 1048576).toFixed(1)}MB`);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 需求(清理缓存菜单-直接清理全部缓存)：不看当前保存的存储空间限额/点歌
// 时间策略，直接把 HLS 转码缓存清空(正在转码中的除外)。
app.post('/api/admin/cache/clean-all', requireAdminAuth, (req, res) => {
  try {
    const result = cacheCleaner.cleanupAll();
    log.info('ADMIN', `管理员手动清理全部缓存: 共清理 ${result.removed} 个，释放约 ${(result.freed / 1048576).toFixed(1)}MB${result.skippedBuilding ? `（另有 ${result.skippedBuilding} 个正在转码中已跳过）` : ''}`);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 曲库来源(网盘/本地目录选择 + 网盘本地缓存调优) ----------
// 需求(网盘等具体设置从 docker-compose.yml 移到曲库后台)：docker-compose.yml
// 现在只固定挂载两个通用目录——本地 /mv、网络/网盘 /mv-net，用户只需要把
// host 上准备好的目录(不管是普通本地文件夹，还是用 fnOS 自带的网盘挂载/
// rclone/alist 等工具挂出来的网盘目录)对应放到这两个共享目录下。具体"这两个
// 目录下的哪些子文件夹要作为曲库根目录纳入扫描、是否按网络路径走本地缓存"，
// 以及网盘本地缓存的几个调优参数，全部在这里管理，保存后立即生效(下一次
// 扫描——不管是定时的还是管理员手动点的——就会用上)，不需要重建容器、不需要
// 重启应用，彻底告别"改配置向导开关 -> 写 docker-compose.yml -> 容器重建，
// 而且重建时机可能早于新目录真正挂载好"这一整套老流程。
// Bug修复("扫描显示5188首，后台曲库显示5192首，怀疑之前网盘挂载被取消后
// 库里有数据清不掉")：这4首差值就是"孤儿曲目"——它们的 source_root 指向的
// 目录已经完全不在当前「曲库来源」配置里了(不是"暂时访问不了"，是配置里
// 压根没有这一条了，比如管理员在 v1.2.1 这次修复之前就已经删掉过某个
// 网盘来源，那时候"移除来源"还不会连带清理曲目，见 DELETE /roots/:idx
// 的历史注释)。scanLibrary() 的清理逻辑只会处理"当前配置里还在、但这一轮
// 扫描时访问不了"的目录下的曲目(见 scanner.js "本轮不可访问就不清理"那段
// 注释)，压根不知道"这个目录以前配置过、现在配置已经没了"这件事，所以这
// 4首就一直卡在数据库里，扫描接口的 total(按磁盘上实际扫到的文件数算)
// 和这里 /api/stats 的 songCount(数据库里的总行数)就会对不上。
// findOrphanSongIds()：找出 source_root 不为空、但压根不在当前任何一个
// 已配置根目录(不管启用还是禁用)里的曲目——source_root 为空的老记录
// (早于多路径改动)不算孤儿，跳过不处理，避免误删。
function findOrphanSongIds() {
  const knownDirs = new Set(getLibraryRoots().map(r => r.dir));
  const rows = db.prepare('SELECT id, source_root FROM songs WHERE source_root IS NOT NULL').all();
  return rows.filter(r => !knownDirs.has(r.source_root)).map(r => r.id);
}

// 需求修复("清理孤儿曲目"没找到，但总数依然对不上)：孤儿曲目的定义是
// "所属根目录已经完全不在当前曲库来源配置里"——如果这次遇到的 4 首歌
// 所属的根目录其实还在配置列表里(只是这一轮物理访问不了，比如网盘取消
// 挂载但配置本身没删)，就不会被上面 findOrphanSongIds() 识别出来，这是
// 故意的：scanLibrary() 本身就不会因为目录"这一轮访问不了"就自动清理，
// 避免网络盘偶尔掉线时被误删(见 scanner.js 顶部注释)。
// 这里换个角度，直接把"每个已配置根目录，这一轮是否能访问、名下各挂了
// 多少首曲目"如实报给前端，管理员一眼就能看出问题出在哪一个来源上，
// 需要的话可以针对那一个来源单独清理(见下面 purge-songs 接口)，不用
// 靠猜。
function getRootsWithStatus() {
  return getLibraryRoots().map(r => ({
    ...r,
    accessible: fs.existsSync(r.dir),
    songCount: db.prepare('SELECT COUNT(*) c FROM songs WHERE source_root = ?').get(r.dir).c,
  }));
}

app.get('/api/admin/library-sources', requireAdminAuth, (req, res) => {
  res.json({
    ok: true,
    baseMounts: BASE_MOUNTS,
    roots: getRootsWithStatus(),
    cacheSettings: sourceCache.getCacheSettings(),
    orphanCount: findOrphanSongIds().length,
  });
});

// 只清空某个仍在配置里的曲库来源名下的曲目，不动这条来源本身的配置——
// 跟"移除来源"(会连带删掉这条配置)是两件独立的事：管理员可能只是想清掉
// 这一批已经确认播不了的旧记录，但保留这条来源配置，以后重新挂载/修好了
// 还想继续用，不想再重新添加一遍。
app.post('/api/admin/library-sources/roots/:idx/purge-songs', requireAdminAuth, (req, res) => {
  const idx = Number(req.params.idx);
  const roots = getLibraryRoots();
  if (!(idx >= 0 && idx < roots.length)) return res.status(404).json({ error: '找不到这个曲库来源' });
  const root = roots[idx];
  const rows = db.prepare('SELECT id FROM songs WHERE source_root = ?').all(root.dir);
  let purgedCount = 0;
  for (const row of rows) {
    try { deleteSongCascade(row.id); purgedCount++; }
    catch (e) { log.error('ADMIN', `清理曲库来源曲目失败(id=${row.id}): ${e.message}`); }
  }
  log.info('ADMIN', `曲库来源: 手动清理「${root.label || root.dir}」名下曲目 ${purgedCount} 首(来源配置本身保留)`);
  res.json({ ok: true, purgedCount });
});

app.post('/api/admin/library-sources/cleanup-orphans', requireAdminAuth, (req, res) => {
  const ids = findOrphanSongIds();
  let purgedCount = 0;
  for (const id of ids) {
    try { deleteSongCascade(id); purgedCount++; }
    catch (e) { log.error('ADMIN', `清理孤儿曲目失败(id=${id}): ${e.message}`); }
  }
  log.info('ADMIN', `曲库来源: 手动清理孤儿曲目 ${purgedCount} 首(所属根目录已不在当前曲库来源配置里)`);
  res.json({ ok: true, purgedCount });
});

// 文件夹浏览器：只允许浏览 BASE_MOUNTS(/mv、/mv-net)本身及其子目录，用于
// 后台"添加曲库来源"时可视化选择子文件夹，不需要用户手动输入路径。
app.get('/api/admin/browse-folder', requireAdminAuth, (req, res) => {
  const dir = resolveLibraryRootPath(req.query.path || '/mv');
  if (!dir) return res.status(400).json({ error: '路径不在允许浏览的范围内(只能是 /mv 或 /mv-net 及其子目录)' });
  if (!fs.existsSync(dir)) return res.status(404).json({ error: `目录不存在，请确认已经把 host 上的文件夹正确挂载到 ${dir}` });
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b, 'zh'));
    res.json({ ok: true, path: dir, folders: entries });
  } catch (e) {
    res.status(500).json({ error: '读取目录失败: ' + e.message });
  }
});

app.post('/api/admin/library-sources/roots', requireAdminAuth, (req, res) => {
  const { dir, label, isNetwork } = req.body || {};
  const resolved = resolveLibraryRootPath(dir);
  if (!resolved) return res.status(400).json({ error: '路径必须位于 /mv 或 /mv-net 之下' });
  if (!fs.existsSync(resolved)) return res.status(400).json({ error: `目录不存在: ${resolved}，请确认对应的 host 目录已经挂载好` });
  const roots = getLibraryRoots();
  if (roots.some(r => r.dir === resolved)) return res.status(409).json({ error: '这个目录已经添加过了' });
  roots.push({ dir: resolved, label: (label || resolved).trim() || resolved, isNetwork: !!isNetwork, enabled: true });
  saveLibraryRoots(roots);
  log.info('ADMIN', `曲库来源: 新增根目录 ${resolved}${isNetwork ? '(网络路径，将走本地缓存)' : '(本地路径)'}`);
  res.json({ ok: true, roots });
});

app.patch('/api/admin/library-sources/roots/:idx', requireAdminAuth, (req, res) => {
  const idx = Number(req.params.idx);
  const roots = getLibraryRoots();
  if (!(idx >= 0 && idx < roots.length)) return res.status(404).json({ error: '找不到这个曲库来源' });
  const { label, isNetwork, enabled } = req.body || {};
  if (typeof label === 'string' && label.trim()) roots[idx].label = label.trim();
  if (typeof isNetwork === 'boolean') roots[idx].isNetwork = isNetwork;
  if (typeof enabled === 'boolean') roots[idx].enabled = enabled;
  saveLibraryRoots(roots);
  log.info('ADMIN', `曲库来源: 更新 ${roots[idx].dir} -> ${JSON.stringify(roots[idx])}`);
  res.json({ ok: true, roots });
});

app.delete('/api/admin/library-sources/roots/:idx', requireAdminAuth, (req, res) => {
  const idx = Number(req.params.idx);
  const roots = getLibraryRoots();
  if (!(idx >= 0 && idx < roots.length)) return res.status(404).json({ error: '找不到这个曲库来源' });
  const removed = roots.splice(idx, 1)[0];
  saveLibraryRoots(roots);
  // Bug修复("取消挂载的曲库文件夹，后台总曲目也没有减少")：以前这里只是把
  // 目录从配置里摘掉，故意不动对应的歌曲记录，理由是"目录暂时访问不了不代表
  // 用户想删数据"——但这混淆了两种完全不同的场景：①网络挂载偶尔掉线/临时
  // 不可访问(scanLibrary() 那边已经有专门的保护，不会因为这个自动清理，见
  // 顶部注释)；②管理员在这里主动点了"移除"，这就是明确的"我不要这个来源了"
  // 的意思，不应该让它名下的曲目继续占着「曲库管理」列表却又扫不到、播不了。
  // 默认清理，除非请求体显式传 purge:false（管理员只是想暂时移出配置、以后
  // 可能重新添加回来，不想动已入库的曲目/播放历史/收藏）。
  const purge = !(req.body && req.body.purge === false);
  let purgedCount = 0;
  if (purge) {
    const rows = db.prepare('SELECT id FROM songs WHERE source_root = ?').all(removed.dir);
    for (const row of rows) {
      try { deleteSongCascade(row.id); purgedCount++; }
      catch (e) { log.error('ADMIN', `曲库来源移除后清理曲目失败(id=${row.id}): ${e.message}`); }
    }
  }
  log.info('ADMIN', `曲库来源: 移除根目录 ${removed.dir}${purge ? `，已连带清理其名下 ${purgedCount} 首曲目及播放历史/收藏记录` : '(保留已入库的歌曲记录，未清理)'}`);
  res.json({ ok: true, roots, purgedCount });
});

app.get('/api/admin/library-sources/cache-settings', requireAdminAuth, (req, res) => {
  res.json({ ok: true, ...sourceCache.getCacheSettings() });
});

app.post('/api/admin/library-sources/cache-settings', requireAdminAuth, (req, res) => {
  const { maxMB, maxAgeDays, concurrency } = req.body || {};
  if (!(Number(maxMB) > 0)) return res.status(400).json({ error: '请填写有效的缓存空间上限(MB)' });
  if (!(Number(maxAgeDays) > 0)) return res.status(400).json({ error: '请填写有效的缓存保留天数' });
  if (!(Number(concurrency) > 0)) return res.status(400).json({ error: '请填写有效的并发拷贝数' });
  const saved = sourceCache.saveCacheSettings({ maxMB: Number(maxMB), maxAgeDays: Number(maxAgeDays), concurrency: Number(concurrency) });
  log.info('ADMIN', `网盘本地缓存调优参数已更新: 上限=${saved.maxMB}MB, 保留=${saved.maxAgeDays}天, 并发=${saved.concurrency}`);
  res.json({ ok: true, ...saved });
});

// ---------- 扫描 / 统计 ----------
// resetAudioTracks：修复"探测失败被永久当成真实单音轨结果缓存"的历史遗留
// 问题——老版本探测失败时会把 audio_tracks 写死成 1，跟"真的探测成功、
// 确认就是单音轨"完全没法区分，正常扫描不会重新碰它。这里给管理员一个
// 显式入口：先把全部歌曲的 audio_tracks 清空成 NULL，再走一次正常扫描，
// 扫描里"补全老曲目音轨数"那段逻辑就会把每一首都重新探测一遍。这是相对
// 重的操作（曲库越大越慢，且用到的是最新放宽到 30s 的探测超时），所以
// 要求管理员登录才能触发，避免被随手误触或被恶意请求反复触发。
// 需求(全盘重新探测音轨排除网络曲库)：这里仍然无差别把所有曲目(含网络/STRM
// 曲目)的 audio_tracks 清空成 NULL——这一步本身只是清空数据库字段，不碰任何
// 文件，不会触发下载，可以放心无差别清。真正决定"清空之后谁会被重新探测"的
// 是 scanner.js scanLibrary() 里紧跟着的两段补全逻辑：本地曲目照常全部重新
// 探测；网络/STRM 曲目只有"已经有本地缓存文件"的那部分会被顺手探测(直接读
// 现成的缓存文件，不触发下载)，没有缓存的网络/STRM 曲目保持 NULL，不会为了
// 这次批量重新探测而被强制下载——它们会在下次真正被点歌/播放时按正常播放
// 路径自然缓存+探测，不需要这里额外处理。也就是说管理员触发这个入口不会再
// 把网盘曲库一次性全部下载缓存到本地了。
// 需求(扫描方式拆分)：新增 mode 参数，三种取值见 scanner.js scanLibrary()
// 顶部注释——'full'(默认，新增+更新+删除，行为跟改动前完全一致)/
// 'incremental'(只新增更新，不删，不管这轮扫描少看到多少文件都不会删任何
// 记录)/'diff'(只读预览，完全不写数据库，用来看"如果现在扫全量会删掉哪些
// 歌")。延续上面注释里的设计：/api/scan 本来就是电视端"扫描曲库"按钮也在
// 用的公共接口，不要求登录，这里不改变这个既有设计——新增的三种模式统一
// 不额外收紧权限，删除这件事本身现在已经由 scanLibrary() 内部的"骤减熔断"
// 兜底保护(见该函数顶部注释)，不依赖"谁能触发扫描"这道门槛。
app.post('/api/scan', async (req, res) => {
  try {
    const mode = (req.body && ['full', 'incremental', 'diff'].includes(req.body.mode)) ? req.body.mode : 'full';
    if (req.body && req.body.resetAudioTracks) {
      if (!isAdminAuthed(req)) return res.status(401).json({ error: '请先登录管理员账号' });
      db.prepare('UPDATE songs SET audio_tracks = NULL').run();
      log.info('SCAN', '管理员触发：已清空全部歌曲的音轨探测结果，本次扫描将重新探测本地曲目及已缓存的网络/STRM曲目，未缓存的网络曲目保持待探测状态，不会被强制下载');
    }
    res.json({ ok: true, ...(await scanLibrary(mode)) });
  }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/stats', (req, res) => {
  const songCount  = db.prepare('SELECT COUNT(*) c FROM songs').get().c;
  // 需求(曲库后台本地/网络分开显示)：总曲目按 is_network 拆成本地/网络两个
  // 数字，供「曲库管理」页面顶部的统计卡片和"本地/网络"切换按钮上的角标
  // 使用。两者相加应该等于 songCount，除非出现 is_network 既不是 0 也不是
  // 1 的脏数据(理论上不会，字段是 INTEGER DEFAULT 0，这里不额外做兜底)。
  const songCountLocal   = db.prepare('SELECT COUNT(*) c FROM songs WHERE is_network = 0').get().c;
  const songCountNetwork = db.prepare('SELECT COUNT(*) c FROM songs WHERE is_network = 1').get().c;
  const queueCount = db.prepare("SELECT COUNT(*) c FROM queue WHERE status!='done'").get().c;
  // 「曲库管理」分好页后，页面上一次只能看到 50 首歌，不能再靠"把当前这
  // 一页的 play_count 加起来"得到总播放次数（那样每翻一页数字都会跳变），
  // 改成这里直接在全表上聚合，跟分页无关，数字始终准确。
  const totalPlays = db.prepare('SELECT COALESCE(SUM(play_count),0) c FROM songs').get().c;
  res.json({
    songCount, songCountLocal, songCountNetwork,
    queueCount, totalPlays, mvDir: getMVDir(), appVersion: APP_VERSION,
    // 需求(本地mv多路径支持)：mvDir 字段为了兼容老版本管理页面继续保留(仍是
    // 第一个本地目录)，多路径的完整配置通过 mvRoots 一起给出，新版管理页面
    // 可以据此展示"当前配置了哪几个目录、哪些是网络路径"。
    mvRoots: getMVRoots().map(r => ({ dir: r.dir, isNetwork: r.isNetwork })),
    sourceCache: sourceCache.getStats(),
  });
});

// ---------- 点歌队列 ----------
// 队列内存缓存：getQueueWithSongs() 每次都执行 JOIN 查询，队列不变时直接返回缓存，
// 避免频繁查数据库。队列变化时(点歌/切歌/置顶/删除)调用 invalidateQueueCache() 失效。
let _queueCache = { data: null, time: 0 };
const QUEUE_CACHE_TTL = 2000;  // 2秒TTL，兜底防止漏失效
function invalidateQueueCache() { _queueCache.data = null; _queueCache.time = 0; }

function getQueueWithSongs() {
  const now = Date.now();
  if (_queueCache.data && (now - _queueCache.time) < QUEUE_CACHE_TTL) {
    return _queueCache.data;
  }
  const data = db.prepare(`
    SELECT q.id as queue_id, q.nickname, q.is_top, q.top_order, q.status, q.created_at, q.is_autoplay,
           s.id as song_id, s.title, s.artist, s.filename, s.cover, s.duration,
           s.audio_tracks, s.audio_needs_soft, s.video_needs_soft, s.is_network, s.is_strm
    FROM queue q JOIN songs s ON q.song_id = s.id
    WHERE q.status != 'done'
    -- 排序修复：置顶只能把一首歌挪到"正在播放"之后的第一位（即整个队列的第二位），
    -- 不能盖过正在播放的那首。旧排序 'is_top DESC, id ASC' 只按置顶标记排，
    -- 完全没考虑播放状态——如果正在播放的这一行本身 is_top=0，任何一首刚被置顶
    -- 的候选歌都会因为 is_top=1 排到它前面，等于把"正在播放"从队首挤下去，
    -- 界面上会显示成"置顶歌曲排在正在播放的歌前面"，观感和语义都不对。
    -- 现在最优先按 status='playing' 排（true=1 排最前），保证正在播放的
    -- 那一行永远占据第一位。
    -- Bug修复(连续置顶时，先前置顶的歌被打回原始排序位置)：其次按
    -- top_order 排——这一列不再是 is_top 那种 0/1 布尔标记，而是"第几次被
    -- 置顶操作选中"的递增序号，NULL 表示从没被置顶过。(top_order IS NULL)
    -- ASC 让"曾经被置顶过"的行整体排在"从没置顶过"的行前面；置顶过的行再
    -- 按 top_order DESC 排，值越大说明置顶得越晚，排最前——也就是最近一次
    -- 置顶操作命中的那首排在紧跟"正在播放"之后的第 2 位，更早被置顶、但
    -- 还没轮到播放的那些依次顺延到第 3、4...位，而不是像旧逻辑那样被清空
    -- 标记后打回按 id 排序的原始位置。从没被置顶过的行之间仍按 id ASC
    -- (点歌顺序)排列。
    ORDER BY (q.status='playing') DESC, (q.top_order IS NULL) ASC, q.top_order DESC, q.id ASC
  `).all();
  _queueCache.data = data;
  _queueCache.time = now;
  return data;
}

// ---------- 已点队列播完后自动随机播放 ----------
// 需求："已点队列播完后是否自动从曲库随机播放，以及是否仅从本地曲库随机
// (不随机到网络/网盘曲库的歌)"。这条设置跟"队列空了之后接下来播什么"是同一
// 件事——而"接下来播什么"完全由服务端 /api/queue/next 决定，是所有已连接
// 设备(TV、平板点歌端、手机遥控端)共享的同一份播放行为，不是"这台设备界面上
// 长什么样"那种每台设备各自记一份的本地偏好(对比：解码模式/主题/默认全屏
// 是 Android Prefs/浏览器 localStorage 各存各的，因为那些只影响这台设备自己
// 怎么渲染)。所以这里持久化在服务端 settings 表(跟语种/风格预设同一张表，
// 同一种 JSON 字符串存法)，而不是下发给客户端本地保存；任何一台设备在"设置"
// 面板里改了，其它设备下次打开设置面板重新拉取到的都是同一份结果，不会出现
// "有的设备开了、有的设备没开"这种没有意义的分歧。
// 不要求管理员登录：跟同一个"设置"面板里解码模式/主题/默认全屏一样，是
// 普通用户日常就该能自己切换的播放偏好，跟"曲库管理后台"那些需要管理员
// 密码才能改的配置(曲库来源目录、缓存清理策略等)不是一回事。
const AUTOPLAY_SETTINGS_KEY = 'autoplay_settings';
const DEFAULT_AUTOPLAY_SETTINGS = { enabled: false, localOnly: false };

function getAutoplaySettings() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(AUTOPLAY_SETTINGS_KEY);
  if (!row) return { ...DEFAULT_AUTOPLAY_SETTINGS };
  try {
    const v = JSON.parse(row.value);
    return { enabled: !!v.enabled, localOnly: !!v.localOnly };
  } catch (e) {
    return { ...DEFAULT_AUTOPLAY_SETTINGS };
  }
}
function setAutoplaySettings(settings) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(AUTOPLAY_SETTINGS_KEY, JSON.stringify(settings));
}

app.get('/api/settings/autoplay', (req, res) => {
  res.json({ ok: true, ...getAutoplaySettings() });
});

app.post('/api/settings/autoplay', (req, res) => {
  const { enabled, localOnly } = req.body || {};
  const saved = { enabled: !!enabled, localOnly: !!localOnly };
  setAutoplaySettings(saved);
  log.info('SETTINGS', `已点队列播完自动随机播放: ${saved.enabled ? '开启' : '关闭'}${saved.enabled ? (saved.localOnly ? '(仅本地曲库)' : '(含网络曲库)') : ''}`);
  res.json({ ok: true, ...saved });
});

// 从曲库随机挑一首。localOnly=true 时只从 is_network=0(本地 /mv 目录，见
// scanner.js 里 BASE_MOUNTS 的注释)的曲目里选，网络/网盘(is_network=1，含
// STRM)曲目一律不会被随机到——这正是这个选项存在的意义：家里/包间网络不稳、
// 或者不想自动播放悄悄消耗网盘流量/触发网盘缓存下载时可以勾选。avoidSongId
// 是刚播完的那首(如果有)，曲库歌曲数大于 1 时尽量不让随机结果紧接着重复
// 播放同一首；只是"尽量"，运气不好连续几次都抽中同一首、或者符合条件的曲库
// 本来就只有这一首时不再强求，直接采用最后一次抽到的结果，不做成死循环。
function pickAutoplaySong(localOnly, avoidSongId) {
  const where = localOnly ? 'WHERE is_network = 0' : '';
  const stmt = db.prepare(`SELECT * FROM songs ${where} ORDER BY RANDOM() LIMIT 1`);
  let song = stmt.get();
  if (!song) return null;
  for (let i = 0; i < 5 && avoidSongId != null && song && song.id === avoidSongId; i++) {
    song = stmt.get();
  }
  return song || null;
}

// 需求(网盘STRM支持)：STRM 曲目在扫描阶段没有被探测过(audio_tracks 还是
// NULL)，第一次真的要播放它才第一次去读 .strm 内容/下载缓存/探测音轨。
// 手动点歌(/api/queue POST)和这里的自动随机播放都可能第一次选中一首 STRM
// 曲目，抽成公共函数避免两处各写一份、以后改探测逻辑漏改一处。异步触发、
// 不阻塞调用方已经发出的响应；sourceCache.ensureCached() 内部的 inflight
// 去重保证同一首歌并发触发多次也只会真正下载一次。
function triggerStrmProbeIfNeeded(song) {
  if (song.is_strm && song.audio_tracks == null) {
    ensureProbedOnDemand(song)
      .then((audio_tracks) => {
        log.info('STRM', `[歌曲 id=${song.id}] 触发按需探测完成，音轨数=${audio_tracks}`);
        broadcastQueue();
      })
      .catch(e => log.warn('STRM', `[歌曲 id=${song.id}] 触发按需探测失败: ${e.message}`));
  }
}

// 从"等待中"队列里挑下一首顶上来播放；如果已经没有等待中的歌了，且"播完
// 自动随机播放"开着，就从曲库随机挑一首直接插入队列标记为播放中，不再回到
// "没有正在播放的歌"的空闲画面。返回值只在"确实自动插入了一首新曲目"时
// 是那首歌(供调用方决定要不要触发 STRM 按需探测)，正常顶上等待中的歌、或者
// 没开自动播放/曲库为空导致确实没有下一首可播时，返回 null。
function promoteNextWaitingOrAutoplay(justFinishedSongId) {
  // 排序跟 getQueueWithSongs() 保持一致：优先挑最近一次被置顶的（top_order
  // 越大越优先），其次没被置顶过的按点歌顺序(id ASC)，见上面 top_order 的
  // 详细注释。
  const nxt = db.prepare("SELECT * FROM queue WHERE status='waiting' ORDER BY (top_order IS NULL) ASC, top_order DESC, id ASC LIMIT 1").get();
  if (nxt) {
    db.prepare("UPDATE queue SET status='playing' WHERE id=?").run(nxt.id);
    return null;
  }
  const settings = getAutoplaySettings();
  if (!settings.enabled) return null;
  const song = pickAutoplaySong(settings.localOnly, justFinishedSongId);
  if (!song) return null; // 曲库为空，或"仅本地"开着但本地曲库没有歌，没有可播的
  db.prepare("INSERT INTO queue (song_id, nickname, status, is_autoplay) VALUES (?, '随机播放', 'playing', 1)").run(song.id);
  db.prepare('UPDATE songs SET play_count=play_count+1 WHERE id=?').run(song.id);
  log.info('AUTOPLAY', `队列播空，自动随机选中「${song.title}」继续播放(${settings.localOnly ? '仅本地曲库' : '含网络曲库'})`);
  return song;
}

app.get('/api/queue', (req, res) => res.json(getQueueWithSongs()));

app.post('/api/queue', (req, res) => {
  const { song_id, nickname } = req.body;
  const song = db.prepare('SELECT * FROM songs WHERE id=?').get(song_id);
  if (!song) return res.status(404).json({ error: '歌曲不存在' });
  const info = db.prepare('INSERT INTO queue (song_id,nickname) VALUES (?,?)').run(song_id, nickname || '匿名歌手');
  db.prepare('UPDATE songs SET play_count=play_count+1 WHERE id=?').run(song_id);
  const playing = db.prepare("SELECT * FROM queue WHERE status='playing'").get();
  if (!playing) {
    db.prepare("UPDATE queue SET status='playing' WHERE id=?").run(info.lastInsertRowid);
  } else if (playing.is_autoplay) {
    // 需求(随机播放时点歌直接切歌)：正在播的这一首是"已点队列播完后自动
    // 随机播放"插进来的曲库填充曲目，不是真人点的歌——用户这时候点歌，
    // 意图很明确是"不想再听随机播放这首了，马上放我点的"，不应该按照
    // 普通排队规则乖乖等这首随机播放的唱完。这里直接把随机播放这一行标
    // 成 done(不写入 history，理由见 promoteNextWaitingOrAutoplay() 和
    // /api/queue/next 里对 is_autoplay 的同款处理：随机播放不算"唱过"，
    // 不该出现在"最近唱过"里)，让刚点的这首立刻顶上变成 playing，广播出去
    // 后前端会跟平时切歌一样自动检测到 queue_id 变化并切换播放，不需要
    // 额外的前端改动。
    db.prepare("UPDATE queue SET status='done' WHERE id=?").run(playing.id);
    db.prepare("UPDATE queue SET status='playing' WHERE id=?").run(info.lastInsertRowid);
  }
  broadcastQueue();
  // 需求(已点列表后台预加载)：新点了一首歌，"接下来会播放哪几首"的预热
  // 窗口可能发生变化(比如队列本来是空的，这首歌直接变成"正在播放")，
  // 触发一次预热调度，提前转码+读时长，不等待其完成即可返回响应。
  schedulePreload();
  res.json({ ok: true, id: info.lastInsertRowid });

  // 需求(网盘STRM支持)：STRM 曲目在扫描阶段完全没有被探测过(audio_tracks
  // 还是 NULL)，第一次被点歌加入队列，才是"这首歌真的要被播放"的信号——
  // 这里才第一次去读 .strm 内容、下载缓存、探测音轨。异步触发、不等待，
  // 不阻塞上面已经发出的点歌响应；schedulePreload() 里的 ensureHLS 转码本身
  // 也会通过 resolvePlaybackPath() 走同一份 sourceCache 缓存，两者对同一个
  // songId 并发触发时 sourceCache.ensureCached() 内部的 inflight 去重会保证
  // 只下载一次。探测成功后广播一次队列更新，前端原/伴唱切换按钮才能拿到
  // 准确的 audio_tracks(在此之前跟"还没探测出来"的老曲目一样，按前端既有
  // 的兜底逻辑处理，不影响正常点歌/排队)。
  triggerStrmProbeIfNeeded(song);
});

app.post('/api/queue/:id/top', (req, res) => {
  // Bug修复(连续置顶时，先前置顶的歌被打回原始排序位置)：这里原来的做法
  // 是把所有非播放中的行 is_top 先清零、再把当前这条设成 is_top=1，保证
  // "同一时刻只有一首歌处于置顶状态"。这个写法本身解决了更早之前"多条
  // is_top=1 谁也顶不动"的问题，但引入了新的问题——比如队列第 5 首被置顶到
  // 第 2 位后，接着置顶另一首歌时，第 5 首的 is_top 标记被清零，它就完全
  // 失去了"曾经被置顶过"这个信息，排序上只能退回按 id ASC(点歌顺序)，从
  // 第 2 位直接弹回最初排队的第 5 位，而不是预期的"顺位顺延到第 3 位"。
  // 修复为：不再用 0/1 布尔标记，而是给这一条打上一个递增的 top_order 序号
  // (取当前队列里出现过的最大 top_order 加一)，不动其它行的 top_order。
  // 排序时 top_order 越大排越前(见 getQueueWithSongs() 里的排序注释)，所以
  // 效果是：这首歌顶到紧跟"正在播放"之后的第 2 位，而之前被置顶过、还没
  // 播放到的那些歌各自的 top_order 都没变，只是相对顺序整体往后顺延一位，
  // 不会被打回它们各自最初的点歌顺序位置。
  const tx = db.transaction((id) => {
    const row = db.prepare('SELECT MAX(top_order) m FROM queue').get();
    const nextOrder = (row && Number.isFinite(row.m) ? row.m : 0) + 1;
    db.prepare('UPDATE queue SET top_order=?, is_top=1 WHERE id=?').run(nextOrder, id);
  });
  tx(req.params.id);
  broadcastQueue();
  // 置顶会改变"接下来紧跟在正在播放之后的第一首"，预热窗口跟着变，
  // 重新调度一次预加载。
  schedulePreload();
  res.json({ ok: true });
});

app.delete('/api/queue/:id', (req, res) => {
  // Bug修复：删除的如果正好是"正在播放"这一首，队列里就没有任何一条
  // status='playing' 的记录了，前端 renderAll() 会直接判定"没有正在播放的歌"，
  // 进入空闲分支（MV框回到品牌欢迎画面、<video> 清空 src），不会自动开始播放
  // 下一首——用户点"删除"以为是顺手跳过这首歌，实际播放直接卡死，点"播放"
  // 按钮也没用（<video> 根本没有 src 可播），必须再手动点一次"切歌"（对应下面
  // /api/queue/next 那条单独的路由）才能救回来。这里在删除前先记一下这条
  // 记录当时的状态，删除后如果它正好是 playing，就照抄"切歌"里挑下一首的
  // 逻辑（置顶优先，其次按点歌顺序）自动顶上来播放，不用用户再手动切一次。
  // 注意这里不写 history——history 表语义是"完整播放过的歌"，这首歌是被中途
  // 删掉的，并不是唱完/切过去的，不应该出现在"最近唱过"里，这一点和
  // /api/queue/next 不同，不能直接复用那段逻辑。
  const row = db.prepare('SELECT * FROM queue WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM queue WHERE id=?').run(req.params.id);
  let autoSong = null;
  if (row && row.status === 'playing') {
    autoSong = promoteNextWaitingOrAutoplay(row.song_id);
  }
  broadcastQueue();
  // 删歌(尤其是删掉正在播放的那首、顶上来一首新的)也会改变预热窗口，
  // 同样需要重新调度一次预加载。
  schedulePreload();
  res.json({ ok: true });
  // 需求(播完自动随机播放)：删掉的正好是正在播放的歌、且队列因此空了、又
  // 恰好自动随机选中了一首之前从没探测过的 STRM 曲目时，跟手动点歌一样需要
  // 触发一次按需探测，理由同 triggerStrmProbeIfNeeded() 的注释。
  if (autoSong) triggerStrmProbeIfNeeded(autoSong);
});

app.post('/api/queue/next', (req, res) => {
  const cur = db.prepare("SELECT * FROM queue WHERE status='playing' ORDER BY id LIMIT 1").get();
  if (cur) {
    db.prepare("UPDATE queue SET status='done' WHERE id=?").run(cur.id);
    // 需求(随机播放不计入最近唱过)：is_autoplay 的这一行是曲库自动填充的，
    // 不是真人点的歌，不写入 history——跟上面 POST /api/queue 里"点歌直接
    // 切歌"分支对随机播放曲目的处理保持一致。
    if (!cur.is_autoplay) {
      db.prepare('INSERT INTO history (song_id,nickname) VALUES (?,?)').run(cur.song_id, cur.nickname);
    }
  }
  // 需求(播完自动随机播放)：以前这里只顶"等待中"的下一首，队列真的空了就
  // 什么都不做，前端据此判定"没有正在播放的歌"回到空闲画面。现在改用共享的
  // promoteNextWaitingOrAutoplay()——它内部会在确实没有等待中的歌时，按
  // /api/settings/autoplay 里保存的开关决定要不要从曲库随机插一首顶上来，
  // 这条判断同时也在下面 DELETE /api/queue/:id 里删掉正在播放的歌时复用，
  // 两个"队列可能变空"的入口行为保持一致。
  const autoSong = promoteNextWaitingOrAutoplay(cur ? cur.song_id : null);
  broadcastQueue();
  // 切歌之后"正在播放"整体往后挪了一位，预热窗口也要跟着往后滚动一格，
  // 让刚进入预热范围的新一首歌尽早开始转码/读时长。
  schedulePreload();
  res.json({ ok: true });
  if (autoSong) triggerStrmProbeIfNeeded(autoSong);
});

// ---------- 播放端角色管理(多终端播放进度同步) ----------
// 需求：电视作为主屏解码播放音视频，手机遥控端、"闺蜜机"点歌屏这类副屏
// 只应该展示点歌界面和只读进度，不应该各自再建一路独立的 HLS/视频流去
// 解码播放——不仅白白多占局域网带宽，几路播放各自独立走时间久了进度还
// 会持续漂移、互相对不上。这里维护一份全局唯一的"播放端"归属：同一时刻
// 只允许一个 deviceId 是播放端，真正负责解码播放并周期上报进度(见下面
// 'progress' 消息)；其余设备一律是"控制端"，切歌/暂停/拖进度等操作照旧
// 走已有的 'control' 广播，由播放端设备收到后代为执行，控制端自己不碰
// 媒体流。
//
// 上锁密码直接复用管理后台的 ADMIN_PASSWORD，不单独引入一套密码体系——
// "锁"本质上是"防止别人手滑/瞎点把正在播的电视顶替掉"的一道门槛，要防
// 的是同一类人(不知情的普通客人)，没必要让管理员再单独记一个密码。
//
// activeDeviceId/locked 只保存在内存，不落盘：服务重启后视为"当前没有
// 播放端"，第一个上线声明角色的设备直接拿到播放端身份，不需要走解锁
// 流程——服务刚重启时压根没有正在播放的播放端可言，"锁"锁的是"顶替一个
// 已经在播的播放端"这个动作，这时候无对象可锁。
let playerState = { activeDeviceId: null, activeDeviceName: '', locked: false };

// 播放端设备周期上报的最新播放进度，供控制端做本地插值展示："现在应该
// 播到哪了"用 currentTime + (Date.now()-updatedAt)/1000 估算，不需要
// 播放端每帧上报、也不需要控制端建立媒体流。paused 为 true 时控制端不
// 应该继续按时间流逝推进这个估算值。
let lastProgress = { queueId: null, currentTime: 0, updatedAt: Date.now(), paused: true, voice: 'original' };

function broadcastPlayerState() {
  const payload = JSON.stringify({ type: 'player_changed', ...playerState });
  wss.clients.forEach(c => { if (c._channel === 'ws' && c.readyState === 1) c.send(payload); });
}

// 设备"声明角色为播放端"(role_announce 里 role==='player')或显式"抢占播放端"
// (player_claim)最终都走这同一份互斥判定，避免两处各写一份、以后改判定
// 条件容易漏改一处。返回 {granted, reason}，reason 只在 granted=false 时
// 有意义，供前端区分"密码错误/未上锁但仍失败"等提示文案。
function tryClaimPlayer(deviceId, deviceName, password) {
  if (!deviceId) return { granted: false, reason: 'invalid' };
  if (!playerState.activeDeviceId || playerState.activeDeviceId === deviceId) {
    // 无播放端 或 就是自己重复声明：直接(继续)持有，顺带刷新一下显示名。
    playerState.activeDeviceId = deviceId;
    playerState.activeDeviceName = deviceName || playerState.activeDeviceName;
    return { granted: true };
  }
  if (playerState.locked) {
    const inputHash = password ? sha256Hex(password) : '';
    if (!hashesMatch(inputHash, sha256Hex(ADMIN_PASSWORD))) {
      return { granted: false, reason: 'locked' };
    }
  }
  // 未上锁，或密码校验通过：顶替原播放端。服务端不会主动断开原设备的 ws
  // 连接，只是随后的 broadcastPlayerState() 会让它发现自己不再是
  // activeDeviceId，前端(见 tv/index.html 的 player_changed 处理)据此
  // 自动切回控制端UI、停止解码播放。
  log.info('PLAYER', `播放端由「${playerState.activeDeviceName || playerState.activeDeviceId}」变更为「${deviceName || deviceId}」`);
  playerState.activeDeviceId = deviceId;
  playerState.activeDeviceName = deviceName || '';
  return { granted: true };
}

// ---------- WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ===== 手机麦克风实时音频通道（/mic）：role=mic 手机上行 PCM，role=tv 电视接收播放 =====
// 与 /ws 共用同一个无 path WebSocketServer，在 connection 里按 pathname 分发，避免两个
// 带 path 的实例互相 abortHandshake。手机经 https 域名(wss)接入满足浏览器安全上下文，
// 电视在局域网用 ws 直连，最终在本进程会合转发。当前仅支持一部手机当麦（第二部收到 busy）。
let activeMic = null;
function micSendJSON(ws, obj) {
  if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }
}
function micPresence() {
  let tvs = 0;
  wss.clients.forEach(c => { if (c._channel === 'mic' && c._role === 'tv' && c.readyState === 1) tvs++; });
  const payload = JSON.stringify({ type: 'presence', phones: activeMic ? 1 : 0, tvs });
  wss.clients.forEach(c => { if (c._channel === 'mic' && c.readyState === 1) { try { c.send(payload); } catch (e) {} } });
}
function handleMicConnection(ws, req) {
  ws._channel = 'mic';
  let role = 'mic';
  try {
    const u = new URL(req.url, 'http://localhost');
    if (u.searchParams.get('role') === 'tv') role = 'tv';
  } catch (e) {}
  ws._role = role;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  if (role === 'mic') {
    if (activeMic && activeMic !== ws && activeMic.readyState === 1) {
      micSendJSON(ws, { type: 'busy', message: '已有一部手机正在使用麦克风' });
    } else {
      activeMic = ws;
    }
  }
  micSendJSON(ws, { type: 'hello', role, phones: activeMic ? 1 : 0 });
  micPresence();

  ws.on('message', (data, isBinary) => {
    if (ws._role !== 'mic' || activeMic !== ws) return; // 只转发当前活动手机
    if (isBinary) {
      wss.clients.forEach(c => {
        if (c._channel === 'mic' && c._role === 'tv' && c.readyState === 1) { try { c.send(data); } catch (e) {} }
      });
    } else {
      try {
        const p = JSON.parse(data.toString());
        const s = JSON.stringify(p);
        wss.clients.forEach(c => {
          if (c._channel === 'mic' && c._role === 'tv' && c.readyState === 1) { try { c.send(s); } catch (e) {} }
        });
      } catch (e) {}
    }
  });
  ws.on('close', () => {
    if (activeMic === ws) activeMic = null;
    micPresence();
  });
  ws.on('error', () => { try { ws.terminate(); } catch (e) {} });
}
// 麦克风通道心跳：30s 一轮清理半开连接，避免手机杀后台后电视端一直误显示手机在线
const micPing = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws._channel !== 'mic') return;
    if (ws.isAlive === false) { try { ws.terminate(); } catch (e) {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 30000);

function broadcastQueue() {
  invalidateQueueCache();  // 队列变化时先失效缓存，getQueueWithSongs 会重新查库
  const payload = JSON.stringify({ type: 'queue', data: getQueueWithSongs() });
  wss.clients.forEach(c => { if (c._channel === 'ws' && c.readyState === 1) c.send(payload); });
}

// 已点队列后台预加载(queuePreload.js)探测到时长后，需要用同一份广播把最新的
// duration 推给所有已连接的客户端(TV/手机)，不用等下一次队列增删改才刷新。
setPreloadUpdateNotifier(broadcastQueue);

// 播放/原伴唱状态：以前手机遥控端的"暂停/播放"图标、"原/伴唱"按钮高亮都是
// 写死的，不会跟着 TV 端真实状态变化——手机上点了暂停，TV 真的暂停了，但
// 手机上按钮还是老样子，看起来像没生效。真实状态(是否暂停、原唱/伴唱)只有
// TV 端自己知道(在 <video> 和 VoiceManager 里)，这里用一个内存变量存一份
// "最近一次 TV 端上报的状态"：TV 端状态变化时通过一条新的 'state' 消息上报，
// 服务端记下来并广播给所有客户端(含手机遥控端自己)；手机端收到后更新按钮
// 图标/高亮。新连接进来时(比如手机端刚打开遥控页)也立刻把这份"最近状态"发
// 一遍，不用等 TV 端下一次状态变化才能同步上。
let lastPlaybackState = { paused: false, voice: 'original' };

wss.on('connection', (ws, req) => {
  let pathname = '/';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (e) {}
  if (pathname === '/mic') { handleMicConnection(ws, req); return; }
  if (pathname !== '/ws') { try { ws.close(); } catch (e) {} return; }
  ws._channel = 'ws';
  ws.send(JSON.stringify({ type: 'queue', data: getQueueWithSongs() }));
  ws.send(JSON.stringify({ type: 'state', ...lastPlaybackState }));
  // 新连接(网页刚打开/刚重连)立刻拿到一份当前的播放端归属+最近一次进度，
  // 不用等下一次角色变化/播放端上报才第一次同步上，跟上面 'queue'/'state'
  // 首连接即推送同一套模式。
  ws.send(JSON.stringify({ type: 'player_changed', ...playerState }));
  ws.send(JSON.stringify({ type: 'progress', ...lastProgress }));
  ws.on('message', msg => {
    try {
      const p = JSON.parse(msg);
      if (p.type === 'control') {
        // 需求("控制模式下禁用全屏，只发送全屏指令到播放端")：'control' 消息
        // 原来一律广播给所有在线客户端(含发送者自己)，由接收端各自判断"我是
        // 不是播放端，是就真的执行"——大多数动作(播放/暂停/音量/均衡器等)这样
        // 完全没问题，客户端本来就有 isActivePlayer 判断。但 fullscreen 比较
        // 特殊：它同时影响"要不要展示一个铺满全屏的界面"这个跟播放身份无关的
        // 本地 UI 状态，如果控制端自己也照单全收，点一下预览框发指令、紧接着
        // 收到服务端广播回来的这条回声，会把控制端本机也拽进一个空白全屏——
        // 客户端那边虽然也加了 isActivePlayer 判断兜底(双保险，见 tv/index.html
        // handleRemote()、Android 两个 Activity 的 onControlAction()"fullscreen"
        // 分支)，但从根上只把这条指令发给真正的播放端，能省掉一次没有意义的
        // 广播往返，其它设备完全不会收到、不需要各自判断一次。找不到播放端
        // (还没人声明播放端角色，或者播放端刚断线)时静默丢弃，不广播给任何人。
        if (p.action === 'fullscreen') {
          if (playerState.activeDeviceId) {
            wss.clients.forEach(c => {
              if (c._channel === 'ws' && c.readyState === 1 && c._deviceId === playerState.activeDeviceId) c.send(JSON.stringify(p));
            });
          }
        } else {
          wss.clients.forEach(c => { if (c._channel === 'ws' && c.readyState === 1) c.send(JSON.stringify(p)); });
        }
      }
      else if (p.type === 'state') {
        lastPlaybackState = { paused: !!p.paused, voice: p.voice === 'accompaniment' ? 'accompaniment' : 'original' };
        const payload = JSON.stringify({ type: 'state', ...lastPlaybackState });
        wss.clients.forEach(c => { if (c._channel === 'ws' && c.readyState === 1) c.send(payload); });
      } else if (p.type === 'role_announce') {
        // 设备声明自己想要的角色。记一下这条 ws 连接对应的 deviceId，供
        // 下面 'close' 时判断"断线的是不是当前播放端"。role==='controller'
        // 不需要走互斥判定——控制端可以同时有任意多个；role==='player'
        // 才需要 tryClaimPlayer() 的单播放端互斥逻辑。
        ws._deviceId = p.deviceId;
        if (p.role === 'player') {
          const result = tryClaimPlayer(p.deviceId, p.deviceName, p.password);
          ws.send(JSON.stringify({ type: 'role_ack', ...result }));
          if (result.granted) broadcastPlayerState();
        } else if (playerState.activeDeviceId === p.deviceId) {
          // 原本是播放端的这台设备主动切回控制端(比如用户在设置里手动
          // 切换)，让出播放端身份并清掉锁——它自己都不想再当播放端了，
          // 继续保留一把锁在一个已经不解码播放的设备名下没有意义。
          playerState = { activeDeviceId: null, activeDeviceName: '', locked: false };
          broadcastPlayerState();
        }
      } else if (p.type === 'player_claim') {
        ws._deviceId = p.deviceId;
        const result = tryClaimPlayer(p.deviceId, p.deviceName, p.password);
        ws.send(JSON.stringify({ type: 'role_ack', ...result }));
        if (result.granted) broadcastPlayerState();
      } else if (p.type === 'player_lock') {
        // 只有当前播放端自己能上锁/解锁，防止任意控制端瞎改别人的锁状态。
        if (playerState.activeDeviceId && playerState.activeDeviceId === p.deviceId) {
          const wantLock = !!p.lock;
          // 上锁不设门槛(播放端自己想锁随时能锁)；但解锁(把已有的锁关掉)要
          // 校验密码(复用 ADMIN_PASSWORD)——否则"锁"形同虚设：谁在播放端
          // 这台设备上随手点一下解锁按钮，就能让任何设备无密码抢走播放端，
          // 等于白锁。
          if (!wantLock && playerState.locked) {
            const inputHash = p.password ? sha256Hex(p.password) : '';
            if (!hashesMatch(inputHash, sha256Hex(ADMIN_PASSWORD))) {
              ws.send(JSON.stringify({ type: 'lock_ack', granted: false, reason: 'wrong_password' }));
              return;
            }
          }
          playerState.locked = wantLock;
          log.info('PLAYER', `播放端「${playerState.activeDeviceName || playerState.activeDeviceId}」${playerState.locked ? '已上锁' : '已解锁'}`);
          broadcastPlayerState();
          ws.send(JSON.stringify({ type: 'lock_ack', granted: true }));
        }
      } else if (p.type === 'progress') {
        // 只采纳当前播放端自己上报的进度，过滤掉旧连接/非当前播放端可能
        // 残留发出的进度消息，避免全局进度被错误的一路数据污染。
        if (playerState.activeDeviceId && playerState.activeDeviceId === p.deviceId) {
          lastProgress = {
            queueId: p.queueId != null ? p.queueId : null,
            currentTime: Number(p.currentTime) || 0,
            updatedAt: Date.now(),
            paused: !!p.paused,
            voice: p.voice === 'accompaniment' ? 'accompaniment' : 'original',
          };
          const payload = JSON.stringify({ type: 'progress', ...lastProgress });
          wss.clients.forEach(c => { if (c._channel === 'ws' && c.readyState === 1) c.send(payload); });
        }
      }
      // 氛围特效(掌声/干杯/喝彩/倒彩)：手机遥控触发，广播给所有大屏(TV网页/tvOS)播音效+全屏emoji刷屏
      else if (p.type === 'atmosphere') {
        const kind = ['applause','cheers','cheer','boo'].includes(p.kind) ? p.kind : null;
        if (kind) {
          const out = JSON.stringify({ type:'atmosphere', kind, from:String(p.from||'').slice(0,20) });
          wss.clients.forEach(c => { if (c._channel === 'ws' && c.readyState === 1) c.send(out); });
        }
      }
      // 祝福语弹幕：手机遥控输入/快捷短语，广播给所有大屏全屏展示，文本限长
      else if (p.type === 'blessing') {
        const text = String(p.text == null ? '' : p.text).trim().slice(0, 60);
        if (text) {
          const out = JSON.stringify({ type:'blessing', text, from:String(p.from||'').slice(0,20) });
          wss.clients.forEach(c => { if (c._channel === 'ws' && c.readyState === 1) c.send(out); });
        }
      }
      // 歌词字体色/描边色：手机遥控实时改色，广播给所有大屏(tvOS/网页TV)同步刷新
      else if (p.type === 'lyrics_style') {
        const msg = { type: 'lyrics_style' };
        if (typeof p.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(p.color)) msg.color = p.color;
        if (typeof p.stroke === 'string' && /^#[0-9a-fA-F]{6}$/.test(p.stroke)) msg.stroke = p.stroke;
        if (typeof p.width === 'number' && p.width >= 0 && p.width <= 12) msg.width = p.width;
        if (typeof p.fontScale === 'number' && p.fontScale >= 0.7 && p.fontScale <= 3.0) msg.fontScale = p.fontScale;
        if (typeof p.posV === 'number' && p.posV >= 0 && p.posV <= 60) msg.posV = p.posV;
        if (msg.color || msg.stroke || typeof msg.width === 'number' || typeof msg.fontScale === 'number' || typeof msg.posV === 'number') {
          const out = JSON.stringify(msg);
          wss.clients.forEach(c => { if (c._channel === 'ws' && c.readyState === 1) c.send(out); });
        }
      }
    } catch(e) {}
  });
  ws.on('close', () => {
    // 播放端设备断线(网页刷新/关闭/断网)：清空播放端归属和锁，让其它设备
    // (包括它自己重连后重新声明)可以立刻拿到播放端身份，不用被一个已经
    // 不在线的"幽灵播放端"卡住——否则要么没人能顶替(如果之前上了锁)，
    // 要么所有设备都显示"当前播放端: xxx"但那台设备其实早就断线了。
    if (ws._deviceId && playerState.activeDeviceId === ws._deviceId) {
      log.info('PLAYER', `播放端「${playerState.activeDeviceName || playerState.activeDeviceId}」已断开连接，播放端归属已清空`);
      playerState = { activeDeviceId: null, activeDeviceName: '', locked: false };
      broadcastPlayerState();
    }
  });
});

server.listen(PORT, () => {
  log.info('SERVER', `KTV 服务已启动: http://0.0.0.0:${PORT}`);
  // 需求(已点列表后台预加载)：服务重启时队列表里可能已经留有上一次运行时
  // 还没播完的记录(容器重建/升级重启不会清空 /data 下的数据库)，这里补一次
  // 启动时的预热调度，覆盖"重启前已经点好但还没轮到播放"的这些歌，不用等
  // 用户再次操作队列(点歌/删歌/切歌/置顶)才被动触发。
  schedulePreload();
});

// Bug修复：原来这行代码写在 server.listen 之前、且同步调用 scanLibrary()，
// 等于让整个 HTTP 服务能不能对外提供响应，都卡在"这一轮曲库扫描有没有跑完"
// 这一点上——MV 目录下堆的曲目越多（尤其首次安装、批量导入曲库的场景），
// 主界面/点歌页面能打开、能看到任何歌曲列表的时间就越晚，用户看到的就是
// 长时间白屏/连不上。
// 现在把启动扫描挪到 server.listen 之后再异步触发：端口立刻开始监听，扫描
// 转为后台任务执行；配合 scanner.js 里改成的"逐个文件探测、逐个立即入库"，
// 这时候查询 /api/songs 看到的列表会随扫描推进逐步变长，不需要等这一整轮
// 扫描全部跑完才第一次看到歌曲。
//
// Bug修复("容器一启动挂载还没生效，扫描把数据库归零")：fnOS/群晖这类平台上，
// docker-compose 的 volume 挂载点(比如 /mv-net)本身是"容器一启动就存在的
// 目录"，但如果这个挂载点在 host 侧对应的是网盘/云盘客户端的挂载(rclone、
// 群晖 Cloud Sync 之类)，host 侧挂载完成的时机跟容器启动完全是两条独立的
// 时间线——容器可能先起来，这时候 /mv-net 在容器里"看起来"是一个存在但空的
// 目录(不是"不可访问"，fs.existsSync 判定不出问题)，如果这时候立刻跑一次
// 会执行删除的扫描，会把网络曲库这些歌当成"全部被删除了"直接清空数据库
// 记录——scanner.js 里新增的"骤减熔断"(见 scanLibrary 顶部注释)已经是最后
// 一道防线，但更好的做法是从源头上避免触发它：
//   1) 启动后先等一个可配置的基础延迟(STARTUP_SCAN_DELAY_MS，默认 20s)，
//      给 host 侧网盘挂载一点先起来的时间；
//   2) 之后再轮询检查一遍每个"网络曲库"根目录：连续两次(间隔几秒)读到的
//      顶层条目数量一致，才认为"这个目录这会儿状态稳定了"，最长总共等
//      STARTUP_SCAN_MAX_WAIT_MS(默认 60s)，超时也不再无限等下去，直接
//      进入第 3 步(反正下一步本身就是安全的，等太久没意义)；
//   3) 不管上面等没等到"稳定"，容器启动后的第一次扫描固定强制用
//      mode='incremental'(只增不删，见 scanner.js)，这一轮无论如何都不会
//      删除任何曲目记录——哪怕网盘这次启动特别慢、超过了两步等待的时间，
//      最多是"这一轮扫描少扫到几首新歌"，不会有任何不可逆的数据丢失。
//      之后不管是定时任务还是管理员手动点击的"全量扫描"，才会真正执行
//      删除(且仍然受"骤减熔断"保护)。
const STARTUP_SCAN_DELAY_MS = Number(process.env.STARTUP_SCAN_DELAY_MS) || 20000;
const STARTUP_SCAN_MAX_WAIT_MS = Number(process.env.STARTUP_SCAN_MAX_WAIT_MS) || 60000;
const STARTUP_SCAN_POLL_INTERVAL_MS = 3000;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms).unref()); }

// 只读一层目录条目数量(不递归)当"这个目录是否还在变化"的轻量信号，避免在
// 等待阶段就对可能几万个文件的曲库根目录做一次完整递归扫描——真正的递归
// 扫描留给后面 scanLibrary() 自己做，这里只是"判断值不值得现在开始扫"。
function shallowEntryCount(dir) {
  try {
    return fs.readdirSync(dir).length;
  } catch (e) {
    return -1; // 目录暂时不可读(还没挂载好/权限问题)，跟"读到 0 个条目"区分开
  }
}

async function waitForNetworkMountsStable() {
  const netRoots = getMVRoots().filter(r => r.isNetwork);
  if (netRoots.length === 0) return; // 没有网络曲库来源，不存在"挂载还没生效"这个问题，不用等

  log.info('SCAN', `检测到 ${netRoots.length} 个网络曲库来源，启动扫描前先等待 ${STARTUP_SCAN_DELAY_MS / 1000}s 让网盘挂载有机会先就绪`);
  await sleep(STARTUP_SCAN_DELAY_MS);

  let prevCounts = new Map(netRoots.map(r => [r.dir, shallowEntryCount(r.dir)]));
  const start = Date.now();
  while (Date.now() - start < STARTUP_SCAN_MAX_WAIT_MS) {
    await sleep(STARTUP_SCAN_POLL_INTERVAL_MS);
    const curCounts = new Map(netRoots.map(r => [r.dir, shallowEntryCount(r.dir)]));
    const allStable = netRoots.every(r => curCounts.get(r.dir) === prevCounts.get(r.dir) && curCounts.get(r.dir) >= 0);
    if (allStable) {
      log.info('SCAN', '网络曲库目录条目数量已连续两次读取一致，视为挂载已就绪');
      return;
    }
    prevCounts = curCounts;
  }
  log.warn('SCAN', `等待网络曲库挂载就绪超时(${STARTUP_SCAN_MAX_WAIT_MS / 1000}s)，仍会继续启动，但首次扫描固定用"增量模式"(只增不删)，不会有数据丢失风险`);
}

(async () => {
  // 应急开关：STARTUP_SCAN_DISABLED=1 时完全跳过"容器启动后的首次自动扫描"。
  // 正常情况不需要设置（扫描已改成异步分批让出，不会再卡住 HTTP）；仅当曲库盘
  // 异常、需要容器先以最快速度对外可用、之后再去后台手动点"扫描曲库"时使用。
  if (process.env.STARTUP_SCAN_DISABLED === '1') {
    log.warn('SCAN', '已通过环境变量 STARTUP_SCAN_DISABLED=1 跳过启动自动扫描，需要时请到后台手动扫描曲库');
    return;
  }
  try {
    await waitForNetworkMountsStable();
  } catch (e) {
    log.warn('SCAN', `等待网络曲库挂载就绪阶段出错(不影响后续启动): ${e.message}`);
  }
  // 首次扫描固定用 incremental：不管上面等到没等到"稳定"，这一轮都绝不会
  // 删除任何曲目记录，把"真正允许删除的全量扫描"留给之后的定时任务/管理员
  // 手动触发，那时候网盘大概率已经完全就绪了。
  scanLibrary('incremental').catch(e => log.error('SCAN', `初始扫描失败: ${e.message}`));
})();

// 需求(新歌放进目录自动入库)：除启动那次外，每隔一段时间自动跑一轮增量扫描，
// 只增不删(incremental 模式不会移除任何曲目)，这样往曲库目录丢新歌后无需手动点扫描。
// 间隔可用环境变量 AUTO_SCAN_MIN 调整，默认 5 分钟；加锁避免上一轮没跑完又起一轮。
let autoScanBusy = false;
const AUTO_SCAN_MS = Math.max(1, parseInt(process.env.AUTO_SCAN_MIN || '5', 10) || 5) * 60 * 1000;
// 应急开关：AUTO_SCAN_DISABLED=1 时不注册定时增量扫描（启动那次仍由
// STARTUP_SCAN_DISABLED 单独控制）。正常使用不要设置，否则丢进目录的新歌不会自动入库。
if (process.env.AUTO_SCAN_DISABLED === '1') {
  log.warn('SCAN', '已通过环境变量 AUTO_SCAN_DISABLED=1 关闭定时增量扫描，新歌需手动扫描入库');
} else {
setInterval(() => {
  if (autoScanBusy) return;
  autoScanBusy = true;
  scanLibrary('incremental')
    .then(r => { if (r && r.added > 0) log.info('SCAN', `自动增量扫描：新增 ${r.added} 首`); })
    .catch(e => log.warn('SCAN', `自动增量扫描失败(不影响运行): ${e.message}`))
    .finally(() => { autoScanBusy = false; });
}, AUTO_SCAN_MS).unref();
}

// 曲库缓存清理：取代原来写死在环境变量里的"每日按固定天数清理"，改由
// cacheCleaner.js 按管理员当前保存的策略（按存储空间限额 / 按点歌时间）执行，
// 具体见该文件顶部注释。这里只负责两个定时触发点：
//   1) 每日兜底清理一次——不管管理员选的是哪种策略，长时间没人碰"清理缓存"
//      按钮时也不会让缓存无限增长；
//   2) 每次有一首歌完整转码完成后，如果当前策略是"按存储空间限额"，立刻
//      检查一次总量是否超限——不需要等到第二天的定时清理才生效，管理员设置
//      的限额能更及时地体现出来。
// 都用 getValidSongIds 的惰性取值（而不是启动时查一次存起来），保证每次
// 触发时用的都是当次最新的曲库状态，不会被注册时刻的旧快照影响。
const DAY_MS = 24 * 60 * 60 * 1000;
setTimeout(() => cacheCleaner.runCleanup(validSongIds), 5 * 60 * 1000).unref();
setInterval(() => cacheCleaner.runCleanup(validSongIds), DAY_MS).unref();
log.info('CACHE_CLEAN', '曲库缓存清理任务已注册（每日兜底一次 + 按存储空间限额时随转码完成即时检查）');

// 需求(网盘先缓存到本地再探测)：网络挂载曲库的本地缓存副本(sourceCache.js)
// 是跟 cacheCleaner.js(HLS 转码产物) 完全独立的一块磁盘占用，用同样的"每日
// 兜底清理一次"节奏跟着跑，策略见 sourceCache.js 顶部注释(孤儿缓存随时清 +
// 按大小/按天数限额)。SOURCE_CACHE_MAX_MB/SOURCE_CACHE_MAX_AGE_DAYS 环境
// 变量可以覆盖默认限额(50GB / 14天)，不需要额外配置也能正常工作。
setTimeout(() => sourceCache.runCleanup(validSongIds), 6 * 60 * 1000).unref();
setInterval(() => sourceCache.runCleanup(validSongIds), DAY_MS).unref();
log.info('CACHE_CLEAN', `网盘本地缓存清理任务已注册（目录: ${sourceCache.CACHE_DIR}）`);

onBuildComplete(() => {
  try {
    if (cacheCleaner.getSettings().mode === 'size') {
      const settings = cacheCleaner.getSettings();
      cacheCleaner.cleanupBySize(settings.sizeLimitMB);
    }
  } catch (e) {
    log.warn('CACHE_CLEAN', `转码完成后的即时缓存检查失败: ${e.message}`);
  }
});
