const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, execFile } = require('child_process');
const { promisify } = require('util');
const db = require('./db');
const { removeHLS } = require('./hlsgen');
const sourceCache = require('./sourceCache');
const log = require('./logger');

const execFileAsync = promisify(execFile);

// 需求(网盘/曲库来源统一放到曲库后台管理)：曲库根目录列表原来完全由
// MV_DIR/MV_DIR_NET 这两个环境变量决定，新增/切换网盘目录都要走"配置向导
// 开关 -> sed 改写 docker-compose.yml -> 容器重建"这一整套流程，用户体验
// 很差，尤其是"容器重建时机早于 install_init 导致新目录还没生效"这个已知
// 坑(见项目历史记录)。现在改成：docker-compose.yml 只固定挂载两个通用
// 目录——本地 /mv 和网络/网盘 /mv-net(用户只需要把 host 上的网盘挂载点/
// STRM 目录对应放到这两个固定共享目录下即可，不再需要为每一种目录单独改
// compose)，具体"这两个目录下的哪些子文件夹要作为曲库根目录纳入扫描、
// 是否按网络路径走本地缓存"这些细节，全部改成保存在数据库 settings 表里、
// 通过「曲库管理」后台的"曲库来源"设置页面维护，改了立刻生效，不需要重建
// 容器、不需要重启应用。
//
// BASE_MOUNTS 就是 docker-compose.yml 里固定挂载的这两个目录，是曲库来源
// 浏览器(admin 后台文件夹选择器)允许浏览、以及校验"新增的根目录必须落在
// 这两个目录之一"的边界——避免通过接口传入任意路径读到容器里曲库目录以外
// 的文件。
const BASE_MOUNTS = [
  { key: 'mv', dir: '/mv', label: '本地曲库 (/mv)' },
  { key: 'mv-net', dir: '/mv-net', label: '网络/网盘曲库 (/mv-net)' },
];

const LIBRARY_ROOTS_KEY = 'library_roots';

function getSettingRaw(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSettingRaw(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function parseDirList(envValue) {
  return String(envValue || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

// 需求(网盘/曲库来源统一放到曲库后台管理)：老版本升级上来的用户，
// docker-compose.yml 里大概率还留着旧版配置向导写入的 MV_DIR(可能是逗号
// 分隔的多个本地路径)/MV_DIR_NET(网盘路径)环境变量——数据库里第一次还没有
// library_roots 这个 setting 时，按这两个环境变量的值原样迁移生成一份初始
// 根目录列表持久化下来，保证升级用户原有的多路径/网盘配置不会因为这次改动
// 丢失，且只在首次迁移这一次，之后就完全以数据库里的配置为准，不再读这两个
// 环境变量。全新安装(环境变量本来就没配过)则给一个只包含 /mv 的默认值。
//
// 补充兜底：新分发的 docker-compose.yml 已经不再包含 MV_DIR_NET 这个环境
// 变量(见 app/docker/docker-compose.yml 改动说明)，所以升级用户实际跑到
// 这个函数时，process.env.MV_DIR_NET 很可能已经是空的，单靠环境变量重建不
// 出原来的网盘目录配置。这里再补一层兜底：直接查 songs 表里已经入库的
// 曲目各自的 source_root/is_network(这两列是扫描曲库时就一直在记录的，
// 不依赖任何环境变量，只要曲库里已经有网盘曲目，这份记录就一定还在)，把
// 环境变量里没覆盖到、但数据库记录里确实存在过的根目录一并补进迁移结果，
// 双重来源取并集、按目录去重，保证不管环境变量是否还在，只要之前扫描
// 成功过，这次迁移都不会漏掉。
function reconstructRootsFromExistingSongs() {
  try {
    const rows = db.prepare('SELECT source_root, is_network, COUNT(*) c FROM songs WHERE source_root IS NOT NULL GROUP BY source_root, is_network').all();
    // 同一个 source_root 理论上 is_network 只会有一种取值(扫描时按它所属的
    // 根目录统一赋值)，万一因为历史原因出现分歧，按数量更多的那一种为准。
    const byDir = new Map();
    for (const row of rows) {
      const prev = byDir.get(row.source_root);
      if (!prev || row.c > prev.c) byDir.set(row.source_root, row);
    }
    return [...byDir.values()].map(row => ({ dir: row.source_root, label: row.source_root, isNetwork: !!row.is_network, enabled: true }));
  } catch (e) {
    console.error('曲库来源迁移: 从已有曲目记录重建根目录列表失败: ' + e.message);
    return [];
  }
}
function migrateLegacyEnvRoots() {
  const localDirs = parseDirList(process.env.MV_DIR || '/mv');
  const netDirs = parseDirList(process.env.MV_DIR_NET);
  const roots = [
    ...localDirs.map(dir => ({ dir, label: dir, isNetwork: false, enabled: true })),
    ...netDirs.map(dir => ({ dir, label: dir, isNetwork: true, enabled: true })),
  ];
  const fromDb = reconstructRootsFromExistingSongs();
  for (const r of fromDb) {
    if (!roots.some(existing => existing.dir === r.dir)) roots.push(r);
  }
  if (roots.length === 0) roots.push({ dir: '/mv', label: '本地曲库', isNetwork: false, enabled: true });
  console.log(`曲库来源: 首次运行，按旧版环境变量+已有曲目记录迁移生成初始根目录列表(共${roots.length}个)，之后请到「曲库管理」后台的"曲库来源"里维护，不再需要改环境变量`);
  return roots;
}

function getLibraryRoots() {
  const raw = getSettingRaw(LIBRARY_ROOTS_KEY);
  if (raw == null) {
    const migrated = migrateLegacyEnvRoots();
    setSettingRaw(LIBRARY_ROOTS_KEY, JSON.stringify(migrated));
    return migrated;
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error('曲库来源配置解析失败，按空列表处理: ' + e.message);
    return [];
  }
}

function saveLibraryRoots(roots) {
  setSettingRaw(LIBRARY_ROOTS_KEY, JSON.stringify(roots));
  return roots;
}

// 校验一个"要新增为曲库根目录"的路径必须落在 BASE_MOUNTS 之一(允许就是
// 挂载点本身，也允许是它的子目录)，防止通过接口传入 "/etc" "../../" 之类
// 路径读到曲库目录以外的容器文件系统内容。返回校验通过后的规范化绝对路径，
// 校验不通过返回 null。
function resolveLibraryRootPath(inputPath) {
  const normalized = path.posix.normalize('/' + String(inputPath || '').replace(/\\/g, '/')).replace(/\/+$/, '') || '/';
  for (const base of BASE_MOUNTS) {
    if (normalized === base.dir || normalized.startsWith(base.dir + '/')) return normalized;
  }
  return null;
}

// 每次都从数据库里现读现算(而不是像老版本那样只在模块加载时算一次)，
// 这样「曲库管理」后台改了曲库来源配置之后，下一次扫描(不管是定时扫描还是
// 管理员手动点"扫描曲库")立刻就能用上最新配置，不需要重启应用容器。
//
// Bug修复("取消挂载的曲库文件夹，后台总曲目也没有减少，列表都重复了")：
// tag 之前是按"当前启用的根目录列表里排第几个"来编号的(L0/L1/N0/N1...)，
// 这在老版本"MV_ROOTS 只在容器启动时算一次、生命周期内永远不变"的前提下
// 没问题。但现在曲库来源随时可能在后台被禁用/启用/新增/删除，只要顺序或
// 启用状态一变，同一个根目录这次算出来的 tag 就可能跟上次不一样——而
// filename 是 `${tag}::相对路径` 拼出来的(见下面 scanLibrary() 里的用法)，
// tag 一变，filename 就变成"没见过的新文件"，明明是同一个根目录下同一批
// 文件，会被当成全新曲目重复插入，旧的那份因为所属根目录状态变化("不可
// 访问"或者干脆被移出配置)又刚好命中"跳过清理"的保护逻辑，永远留在数据库
// 里——曲目越滚越多，列表看着全是重复的，就是这么来的。
// 改成 tag 只由这个根目录自己的 dir 算出来(取路径的短哈希)，完全不受其它
// 根目录增删/启用状态/排列顺序影响：同一个 dir 不管什么时候算，算出来的
// tag 必然一样，天然稳定。
function stableTagFor(dir, isNetwork) {
  const hash = crypto.createHash('md5').update(dir).digest('hex').slice(0, 8);
  return (isNetwork ? 'N' : 'L') + hash;
}
function getMVRoots() {
  const roots = getLibraryRoots().filter(r => r.enabled !== false);
  return roots.map(r => ({
    dir: r.dir,
    tag: stableTagFor(r.dir, !!r.isNetwork),
    isNetwork: !!r.isNetwork,
  }));
}

// 保留原来的 MV_DIR 导出(仍指向第一个本地目录)，兼容 index.js 里
// "/api/stats 展示曲库目录"这类只关心"随便给个目录展示一下"的场景；真正
// 决定"扫描/校验都覆盖哪些目录"的逻辑一律走上面的 getMVRoots()，不再依赖
// 这个单一目录常量。改成函数是因为曲库来源现在随时可能在后台被改，不能再
// 用模块加载时算一次的常量。
function getMVDir() {
  const roots = getMVRoots();
  const firstLocal = roots.find(r => !r.isNetwork);
  return (firstLocal || roots[0] || { dir: '/mv' }).dir;
}

// 新增对 .mpg (MPEG-1/2 Program Stream) 格式的支持：曲库扫描环节只需要把
// 后缀加入白名单即可正常入库；实际播放走 hlsgen.js 的转码流程，非 h264
// 编码（.mpg 源文件常见的 mpeg1video/mpeg2video）会被 SAFE_VIDEO_CODECS
// 判定为不可直拷贝，自动走 VAAPI/libx264 转码分支，不需要针对该格式
// 额外改动转码逻辑。
const VIDEO_EXT = ['.mp4', '.mkv', '.avi', '.flv', '.mov', '.webm', '.mpg'];

// 需求(网盘STRM支持)：.strm 是一个纯文本"指针文件"，内容是网盘里真实媒体
// 文件的地址(网络挂载路径或 http(s) 直链)，不是媒体文件本身。曲库扫描阶段
// 只当它是"一个可以入库的文件名"来处理(跟 VIDEO_EXT 走同一套 listFilesRecursive
// 收录逻辑)，文件名解析(parseFilename)也是用 .strm 文件自己的 basename——
// 命名规范要求"歌手-歌曲名-语种-风格"体现在文件名上，.strm 只是把这套规范
// 套在一个文本文件外壳上。真正读取内容、下载、探测都推迟到点歌加入队列那
// 一刻才做，见 ensureProbedOnDemand() 和 index.js 里 POST /api/queue 的调用。
const STRM_EXT = '.strm';

// Bug修复：原唱/伴唱切换失效的根源——浏览器的 HTMLMediaElement.audioTracks
// 在本应用运行的浏览器内核里没有真正实现（对本地文件播放，长度恒为0），前端
// 永远无法知道一个 MV 到底有几条音轨，只能靠猜（猜错就把双音轨文件当单音轨/
// 声道型处理）。真正可靠的办法是在扫描曲库时用 ffprobe 直接读取音轨数量存入
// 数据库，播放时把这个数字告诉前端，播放器不用再猜。
// Bug修复（同一首歌在不同主机上"原/伴唱切换"表现不一致的根源）：以前探测
// 失败(ffprobe 超时/找不到/文件在慢速 NAS 上一时读不出来...)时返回的是
// 兜底值 1——这个值跟"探测成功、确认就是单音轨"完全没法区分，一旦写进
// 数据库就永久定型：后面"补全老曲目音轨数"那段逻辑只找 audio_tracks
// IS NULL 的行，audio_tracks=1 会被当成"已经探测过"，不会再重试，哪怕
// 探测失败纯粹是当时机器负载高/网络共享抖动这类偶发原因。
// 现网实测两台主机对同一首双音轨歌曲的行为差异（同一份文件）：负载低的
// 那台正确识别出 2 条音轨、编码信息齐全、可以直拷贝；负载高的那台探测
// 全部返回"未知/1条"，导致每次播放都要整曲重新转码（耗时从 7s 涨到
// 84s），且原/伴唱切换从"多音轨(HLS audioTrack)"的无缝切换退化成
// "双声道(Web Audio 声道复制)"这个准确率更低的兜底方案——这正是"探测
// 失败被永久当成真实结果缓存"的典型后果。
// 现在探测失败时返回 null（不是 1），并把 ffprobe 的真实失败原因打进
// 日志，方便区分"这台机器就是探测不出来"还是"只是暂时慢"；null 会被
// 播放时的 `song.audio_tracks || 1` 安全兜底成单音轨（不影响正常播放），
// 同时会被"补全老曲目音轨数"那段逻辑在下次扫描时自动重新探测一次，
// 直到某次探测成功为止，不需要人工干预。超时也从 15s 放宽到 30s，减少
// 机器负载高时被误判为"探测失败"的概率。
//
// 需求(网盘先缓存到本地再探测)顺带修复：这个函数原来是 execFileSync 同步
// 阻塞调用——本地曲库场景下単次几十/几百毫秒感知不到，但网络挂载曲库一旦
// 单个文件读取慢，会连带冻住整个 Node 事件循环(HTTP/WS 全部没响应)，是
// "网盘曲库扫描时页面完全打不开"的根因。现在改成跟 probeDurationAsync()
// 一样的异步版本(execFile 而不是 execFileSync)，双重防护：
//   1) 网络路径的文件在探测之前已经被 sourceCache.js 缓存成本地文件了
//      (见 resolveProbePath())，正常情况下探测本身根本不会碰网络 IO；
//   2) 即使是本地磁盘偶尔卡顿(比如机械硬盘在忙别的 IO)，异步调用也不会
//      冻住事件循环，顶多这一次探测慢一点，其它请求不受影响——双重防护，
//      不完全依赖"网络路径一定会被成功缓存"这一个前提。
// 需求修复("硬解直连没声音，切音轨才报硬解失败自动切软解")：这里列出的是已经
// 实测确认在部分 Android 设备(尤其是缺少厂商额外软解码器补充包的机型)的
// MediaCodec 上没有对应解码器、会在 ExoPlayer 里直接抛
// DecoderInitializationException 的音频编码。目前实测确认的只有 mp2
// (MPEG-1 Layer II，Format(...audio/mpeg-L2...) format_supported=NO_UNSUPPORTED_TYPE)，
// 这类老式卡拉OK压制的 MKV 非常常见。跟视频编码不一样，音频解码失败在硬解
// 模式下往往不会让整个播放直接报错/黑屏——画面能正常出，只是没声音，用户很
// 容易误以为是别的问题，直到切换原/伴唱音轨触发音频渲染器重新初始化才会
// 真正报错。以后如果实测又发现别的编码有同样问题，往这个数组里加一项即可，
// 不需要改调用方逻辑。
const PROBLEM_AUDIO_CODECS = new Set(['mp2']);
function isProblemAudioCodec(codecName) {
  return !!codecName && PROBLEM_AUDIO_CODECS.has(String(codecName).toLowerCase());
}

// 需求修复("RV40硬解黑屏，声音正常")：这里列出的是已经实测确认在 Android
// MediaCodec 上基本没有真正硬件解码支持的老视频编码。RV40(RealVideo 8/9/10)
// 是最常见的一个——个别设备/ROM 上能找到厂商塞的软件/兼容解码器组件，能被
// MediaCodec 枚举到、"成功"初始化、不抛任何异常，但根本没有把解出来的帧
// 真正送上 Surface，跟 mp2 那种"硬解模式下没声音"不一样，这类视频编码在硬解
// 模式下几乎不存在能被判定为"安全"的例外，也没有音频那样"切一次音轨才报错"
// 的自愈时机——ExoPlayer 的 onPlayerError() 永远不会触发，用户只会看到黑屏
// 卡死。与其在客户端埋一堆超时兜底，不如跟 mp2 用一样的思路在扫描阶段就直接
// 标记死，点歌那一刻就走软解，从根上避免用户看到这个黑屏。以后如果实测又
// 发现别的视频编码有同样问题，往这个数组里加一项即可，不需要改调用方逻辑。
const PROBLEM_VIDEO_CODECS = new Set(['rv40', 'rv30', 'rv20', 'rv10']);
function isProblemVideoCodec(codecName) {
  return !!codecName && PROBLEM_VIDEO_CODECS.has(String(codecName).toLowerCase());
}

// 返回 { tracks, audioNeedsSoft, videoNeedsSoft }：tracks 探测失败时为 null
// (语义同旧版本，见下方注释)，audioNeedsSoft/videoNeedsSoft 探测失败或没有
// 对应流时保守返回 0(不要因为探测失败就把本来能硬解播放好的歌强制拖去软解)。
// 需求修复("RV40硬解黑屏，声音正常")：原来这里只用 -select_streams a 探测
// 音频，现在去掉这个过滤、同一次 ffprobe 调用里把视频流的 codec_name 也一并
// 读出来，不需要为视频编码额外再起一个 ffprobe 进程(扫描曲库时这个函数会对
// 曲库里每一首歌都跑一次，多起一个进程等于把整库扫描耗时翻倍)。
// Bug修复(严重)：这里原来用 `-of csv=p=0` 输出，代码假设列顺序跟随
// `-show_entries stream=index,codec_type,codec_name` 里写的顺序(index在第0列,
// codec_type在第1列, codec_name在第2列)——但 ffprobe 的 csv/default writer
// 不遵循 -show_entries 里字段的书写顺序，是按内部固定 schema 顺序输出的(实测
// 是 index,codec_name,codec_type，跟代码假设的 index,codec_type,codec_name
// 顺序对调了)，导致 `cols[1] === 'audio'` 这个判断拿到的其实是 codec_name
// (h264/mp2/aac这类值)，永远不可能等于字符串"audio"，audioRows/videoRows
// 永远是空数组：
//   - audio_tracks 探测结果永远兜底成 1，不管源文件实际有几条音轨
//   - firstAudioCodec/firstVideoCodec 永远是 null，PROBLEM_AUDIO_CODECS(mp2硬解
//     无声音)/PROBLEM_VIDEO_CODECS(RV40黑屏)这两个兜底判断因此从未真正触发过
// 改用 `-of json` 按字段名(codec_type/codec_name)取值，不再依赖任何列顺序
// 假设——这是 ffprobe 官方推荐的可编程消费方式，csv/default 这种位置相关的
// 输出格式本来就不该被当成"顺序等于请求顺序"来解析。
async function probeAudioTracks(filepath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=index,codec_type,codec_name',
      '-of', 'json',
      filepath
    ], { timeout: 30000 });
    const streams = JSON.parse(stdout).streams || [];
    const audioRows = streams.filter(s => s.codec_type === 'audio');
    const videoRows = streams.filter(s => s.codec_type === 'video');
    const count = audioRows.length > 0 ? audioRows.length : 1;
    // 多音轨文件里各条音轨基本都是同一种编码(同一批压制)，取第一条的
    // codec_name 判定即可，不需要逐条检查；视频流同理，取第一条(极少有多
    // 视频流的 MV 文件)。
    const firstAudioCodec = audioRows.length > 0 ? audioRows[0].codec_name : null;
    const firstVideoCodec = videoRows.length > 0 ? videoRows[0].codec_name : null;
    const audioNeedsSoft = isProblemAudioCodec(firstAudioCodec) ? 1 : 0;
    const videoNeedsSoft = isProblemVideoCodec(firstVideoCodec) ? 1 : 0;
    return { tracks: count, audioNeedsSoft, videoNeedsSoft };
  } catch (e) {
    console.error('ffprobe 音轨检测失败(' + path.basename(filepath) + ')，原因: ' + e.message + '；已标记为待重新探测，下次扫描会自动重试');
    return { tracks: null, audioNeedsSoft: 0, videoNeedsSoft: 0 }; // 探测失败时不写死为1，留空让下次扫描自动重试，不永久误判为单音轨
  }
}

// 需求(网盘先缓存到本地再探测)：探测/时长读取之前，先把"这首歌真正应该读
// 哪个文件"这件事确定下来——本地路径直接原样返回；网络路径先调用
// sourceCache.ensureCached() 拷贝到本地(如果已经有新鲜缓存会立刻返回，不
// 重复拷贝)，返回的是本地缓存文件路径。isNetwork 由调用方根据文件属于
// MV_ROOTS 里的哪个根目录传入，这里不重复判断。
// 缓存失败(比如网络挂载已经断开连接)时向上抛出异常，调用方(scanLibrary)
// 会按"单个文件处理失败，只记日志跳过，不影响其它文件"的既定原则处理，
// 不会打断整轮扫描。
// 需求(网盘STRM支持)：原来只按 isNetwork 判断要不要走 sourceCache，现在
// STRM 曲目(filepath 是本地 .strm 文本文件)也需要——统一改成 needsCache，
// 调用方传 `root.isNetwork || isStrm`(或者曲目行的 `is_network || is_strm`)。
// sourceCache.resolveSourceInput() 内部会识别 .strm 后缀并读取真实源地址，
// 这里不需要重复判断文件是不是 .strm。
async function resolveProbePath(songId, filepath, needsCache) {
  if (!needsCache) return filepath;
  return sourceCache.ensureCached(songId, sourceCache.resolveSourceInput(filepath));
}

// 需求（已点列表后台预加载——提前读取时长）：曲库扫描 scanLibrary() 只探测
// audio_tracks，从来不写 songs.duration（这张表虽然建了 duration 列，但一直
// 没有任何地方真正探测并回填过），前端因此一直没法在"已点"列表里提前显示
// 每首歌的时长。这里补一个探测函数，跟 probeAudioTracks() 读的是同一份
// ffprobe 输出结构，但只取 format.duration。
// 特意用 execFile(异步版) 而不是 probeAudioTracks() 那种 execFileSync：
// probeAudioTracks() 只在 scanLibrary() 后台整库扫描时调用，扫描本身是一个
// 独立跑的批处理任务，同步阻塞不影响接口响应；而这个函数会被"已点队列后台
// 预加载"在处理点歌请求的同一个 Node 进程里按队列变化触发，如果用同步版本，
// ffprobe 探测的这几十到几百毫秒会卡住整个事件循环，导致点歌、播放等所有
// 接口在这段时间里一起变慢——所以这里必须用不阻塞事件循环的异步版本。
// 返回值：整数秒；探测失败(ffprobe 找不到/文件损坏/超时)时返回 null，不写死
// 兜底值，避免把"探测失败"永久当成"真实时长=0"存进数据库。
async function probeDurationAsync(filepath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      filepath
    ], { timeout: 30000 });
    const seconds = parseFloat(String(stdout).trim());
    if (!isFinite(seconds) || seconds <= 0) return null;
    return Math.round(seconds);
  } catch (e) {
    console.error('ffprobe 时长探测失败(' + path.basename(filepath) + ')，原因: ' + e.message + '；本次跳过，队列里下次仍会重试');
    return null;
  }
}

// Bug2修复：排除"已缺失的文件"。
// 原实现只根据 readdir 返回的目录项类型（entry.isDirectory()/文件名后缀）来判断是否入库，
// 完全没有校验文件是否真的可读/真的存在。这在网络曲库（NAS/软链接）场景下会漏判两类
// "已缺失"的情况：
//   1) 断开的软链接：readdirSync 只看链接本身的类型，不会跟随链接去检查目标是否存在，
//      一个指向已删除源文件的死链接会被当成正常视频文件收录进曲库，点唱时才发现播放不了。
//   2) 子目录在遍历过程中变得不可访问（网络共享抖动/权限变化）：原来的 readdirSync 会直接
//      抛异常，导致整个 scanLibrary() 中途崩溃退出，后面"清理已不存在文件记录"的逻辑根本
//      没机会执行，已经真正丢失的文件反而没有被清理掉。
// 修复：用 fs.existsSync(full) 顺着链接校验目标真实存在性来过滤死链接；用 try/catch 包裹
// 每一层目录的读取，单个坏目录只跳过不中断整体扫描。
function listFilesRecursive(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    console.error('曲库目录读取失败，已跳过(' + dir + '):', e.message);
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    // fs.existsSync 会跟随符号链接检查目标是否真实存在；断链/目标已删除的文件在此被排除
    if (!fs.existsSync(full)) continue;
    let isDir;
    try {
      isDir = entry.isDirectory() || fs.statSync(full).isDirectory();
    } catch (e) {
      continue; // 探测失败（如挂载点抖动导致stat失败），视为不可用文件，跳过
    }
    if (isDir) {
      results = results.concat(listFilesRecursive(full));
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (VIDEO_EXT.includes(ext) || ext === STRM_EXT) {
        results.push(full);
      }
    }
  }
  return results;
}

// 文件名解析规则：统一命名规范"歌手-歌曲名-语种-风格"（语种、风格可省略）。
// 歌手段可能有多位歌手，用空格分隔，如"刀郎 张三-XXX-国语-流行.mkv"；歌曲名
// 本身也可能包含"-"（如"金刚经(特别版)[1080P]"这类经过二次加工的文件名片段
// 里偶尔会带"-"），所以不能简单按第一个/最后一个"-"切分，而是：
//   1) 按"-"切成若干段，去掉空白段；
//   2) 第 1 段固定是歌手（可能包含多个用空格分隔的歌手名）；
//   3) 段数 >= 4 时，最后两段固定是"语种"和"风格"，中间（去掉首尾）的所有
//      段重新用"-"拼接回歌曲名，这样歌曲名内部原有的"-"不会被破坏；
//   4) 段数为 3 时，只有"语种"没有"风格"；段数为 2 时只有歌手和歌曲名；
//   5) 只有一段（没有任何"-"分隔符）或整段解析失败时，沿用原来的兜底：
//      歌手记为"未知歌手"，全部内容当歌曲名。
// 语种、风格缺失时统一返回空字符串，由调用方决定存 NULL 还是空串。
function parseFilename(filename) {
  const base = path.basename(filename, path.extname(filename));
  const parts = base.split('-').map(s => s.trim()).filter(p => p.length > 0);

  if (parts.length === 0) {
    return { artist: '未知歌手', title: base, language: '', genre: '' };
  }
  if (parts.length === 1) {
    return { artist: '未知歌手', title: parts[0], language: '', genre: '' };
  }
  if (parts.length === 2) {
    return { artist: parts[0], title: parts[1], language: '', genre: '' };
  }
  if (parts.length === 3) {
    return { artist: parts[0], title: parts[1], language: parts[2], genre: '' };
  }
  const genre = parts[parts.length - 1];
  const language = parts[parts.length - 2];
  const title = parts.slice(1, parts.length - 2).join('-');
  return { artist: parts[0], title, language, genre };
}

// 把"歌手"字段（可能是"刀郎 张三"这种空格分隔的多歌手字符串）拆成规范化
// 的单个歌手名数组，用于同步 song_artists 关联表。多个空格、首尾空白都会
// 被清理掉，空字符串直接过滤。
function splitArtists(artistStr) {
  return String(artistStr || '').split(/\s+/).map(s => s.trim()).filter(Boolean);
}

// 把一首歌当前的歌手字段同步进 song_artists 关联表：先删掉这首歌之前的所有
// 关联记录，再按最新的歌手字段重新插入。扫描新增歌曲、后台编辑歌手信息都
// 要调用这个函数，保证"歌手列表"（/api/artists、按歌手精确查曲目）里每一位
// 歌手都能分别展示、分别统计，即使这首歌是多人合唱。
function syncSongArtists(songId, artistStr) {
  db.prepare('DELETE FROM song_artists WHERE song_id = ?').run(songId);
  const insertArtist = db.prepare('INSERT OR IGNORE INTO song_artists (song_id, artist) VALUES (?, ?)');
  for (const name of splitArtists(artistStr)) {
    insertArtist.run(songId, name);
  }
}

// 让出一次事件循环。ffprobe 探测本身用的是同步的 execFileSync，扫描期间没法
// 避免这一小段阻塞，但只要在处理完每一个文件后都让一次事件循环，HTTP/WS
// 请求就能在文件与文件之间的间隙被正常处理，不会排队等到整轮扫描结束——这也
// 是让新入库的曲目能立刻通过 /api/songs 查到、主界面列表随扫描进度逐步变长
// （而不是等全部扫描完才一次性出现）的关键。
function yieldToEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

// 需求(本地mv多路径支持)：原来只扫一个 MV_DIR，现在依次扫 MV_ROOTS 里配置的
// 每一个根目录(本地 + 网络)，汇总成一份"当前这一轮实际看到了哪些文件"的清单，
// 供后面清理已删除文件那一步使用。
// 需求(关键安全防护，延续原有 Bug2 修复的思路)：单个根目录暂时挂载失败/不可
// 访问时，只跳过这一个根目录(记日志)，不中止其它根目录的扫描；但被跳过的
// 根目录，它名下已经入库的歌曲这一轮绝对不能被当成"文件已消失"清理掉——
// 后面清理阶段会按"这个根目录本轮到底有没有被成功扫描"来精确判断，而不是
// 简单地"文件当前存在的完整集合里找不到就删"，避免一个网盘暂时掉线就把它
// 名下几百首歌的库记录批量误删。
function listAllFiles() {
  const perRoot = []; // { root, files: string[], accessible: boolean }
  for (const root of getMVRoots()) {
    if (!fs.existsSync(root.dir)) {
      console.error(`曲库目录不可访问，本轮跳过(不影响其它目录，也不会清理这个目录名下已入库的曲目): [${root.tag}] ${root.dir}`);
      perRoot.push({ root, files: [], accessible: false });
      continue;
    }
    perRoot.push({ root, files: listFilesRecursive(root.dir), accessible: true });
  }
  return perRoot;
}

// 需求(扫描方式拆分 + 启动期误删防护)：原来只有一种"扫描"——每次都是
// "扫新文件 + 探测音轨/语种 + 清理已消失文件"一把梭全干，这在两类场景下
// 都不合适：
//   1) 容器刚启动、定时自动触发这类"不受管理员直接控制"的场景——如果这时候
//      网盘/网络挂载碰巧还没真正生效(host 层面的挂载点在容器启动时序上可能
//      晚于容器本身就绪，是已知的平台限制)，扫描看到的是一个"存在但是空的"
//      目录，跟"目录彻底不可访问"(fs.existsSync 为 false)在文件系统语义上
//      完全没区别，之前只对"不可访问"做了保护，"存在但突然空了"这种情况会
//      被正常当成"这些歌真的被删了"，一次误扫就把整个网络曲库的记录清零。
//   2) 管理员想看看"如果现在点全量扫描，会删掉哪些歌"，但又不想在看到结果
//      之前就真的执行删除——原来没有这种"只看不改"的预览能力。
// 这里把 scanLibrary 拆成三种 mode，行为差异只体现在"要不要执行删除"和
// "要不要真的写数据库"这两个维度，新增/更新曲目这部分逻辑三种模式完全一样、
// 不重复实现：
//   'full'        —— 默认，等价于原来的行为：新增 + 补全探测 + 删除已消失，
//                     但删除这一步现在多了下面 buildRemovalPlan() 的"骤减
//                     熔断"保护，不是无脑执行。管理员在后台点"全量扫描"、
//                     以及每天的定时任务都用这个。
//   'incremental'  —— 只新增/更新，完全跳过删除步骤，不管这一轮看到的文件
//                     比数据库记录少多少都不会删任何一条曲目记录。用于
//                     "不完全信任这一轮扫描环境"的场景——容器刚启动后的第
//                     一次自动扫描固定用这个模式，网盘/网络挂载哪怕这时候
//                     还没生效，最多是"新歌没扫进来"，等下一轮扫描(不管是
//                     等挂载生效后管理员手动点，还是下次容器重启)自然会
//                     补上，绝不会出现"数据库被清空"这种不可逆的后果。
//   'diff'         —— 只读预览，不写数据库、不新增、不删除、不触发任何
//                     探测/网络挂载 IO，只是把"这一轮看到的文件"跟"数据库
//                     里现有记录"做一次比较，返回将会新增/将会删除的清单，
//                     供管理后台在真正执行"全量扫描"之前先看一眼"这次会删
//                     掉哪些歌"，自己判断是不是符合预期。
async function scanLibrary(mode = 'full') {
  if (getMVRoots().length === 0) {
    console.error('曲库扫描已跳过：「曲库管理」后台的"曲库来源"里一个启用中的目录都没有配置');
    return { total: 0, added: 0, removed: 0, error: 'MV_DIR_UNAVAILABLE', mode };
  }

  const perRoot = listAllFiles();
  // 至少要有一个根目录这一轮真的扫成功了，才允许后面执行"清理已消失文件"这
  // 一步——如果所有根目录这一轮全都不可访问(比如网络整个断了)，直接中止，
  // 避免灾难性误删；这是原来单目录版本 Bug2 修复思路在多目录场景下的延伸。
  const anyAccessible = perRoot.some(r => r.accessible);
  if (!anyAccessible) {
    console.error('曲库扫描已跳过：所有配置的目录本轮都不可访问，为避免误删曲库直接中止');
    return { total: 0, added: 0, removed: 0, error: 'MV_DIR_UNAVAILABLE', mode };
  }

  if (mode === 'diff') return runDiffPreview(perRoot);

  const insert = db.prepare(`
    INSERT INTO songs (title, artist, language, genre, filename, filepath, audio_tracks, source_root, is_network, is_strm, cache_status)
    VALUES (@title, @artist, @language, @genre, @filename, @filepath, @audio_tracks, @source_root, @is_network, @is_strm, @cache_status)
    ON CONFLICT(filename) DO NOTHING
  `);
  const existing = db.prepare('SELECT filename FROM songs').all().map(r => r.filename);
  const existingSet = new Set(existing);

  // 渐进式扫描：逐个文件探测、探测完立即单独 INSERT 并让出一次事件循环——
  // 前面已经扫完的歌马上就能被 /api/songs 查到，主界面列表随扫描推进逐步
  // 变长，不需要等全部文件都扫完。单条记录探测/入库失败只记日志跳过，不
  // 影响其余文件继续扫描。网络目录下的文件在探测之前会先被
  // sourceCache.ensureCached() 缓存到本地(见 resolveProbePath())，这一步
  // 本身可能耗时较久(取决于文件大小和网络速度)，但因为是 await 而不是同步
  // 阻塞，等待期间 HTTP/WS 请求仍然能被正常处理，不会重演"网盘曲库扫描时
  // 整个页面打不开"的问题。
  let added = 0;
  let retagged = 0, mergedDup = 0;
  const allCurrentFilenames = new Set();
  for (const { root, files } of perRoot) {
    for (const f of files) {
      const rel = `${root.tag}::${path.relative(root.dir, f)}`;
      allCurrentFilenames.add(rel);
      if (!existingSet.has(rel)) {
        // Bug修复("取消挂载的曲库文件夹，后台总曲目也没有减少，列表都重复
        // 了")：filename 的 tag 前缀改成按根目录 dir 稳定算之前，同一个物理
        // 文件在"曲库来源"配置发生变化(禁用/启用/新增/删除其它根目录)后可能
        // 会算出不一样的 tag，进而在这里被误判成"没见过的新文件"重复插入。
        // 这里在真正插入新记录之前，先按 filepath(文件在磁盘上的绝对路径，
        // 跟 tag 怎么算无关，同一个物理文件永远一样)查一遍库里是不是已经有
        // 对应记录——如果有，说明只是 tag 变了，直接把老记录的 filename/
        // source_root 更新成这次算出来的新值就行，不当新曲目处理，播放次数/
        // 收藏/历史这些跟这首歌绑定的数据都还在，不会丢。
        // 如果同一个 filepath 命中了不止一条记录(比如这个 bug 已经导致重复
        // 插入过)，保留播放次数最高(其次是 id 更小、更早入库)的那一条当
        // "正主"更新，其余的按重复记录直接级联删除清理掉——这样即使已经因为
        // 这个 bug 产生过重复曲目，装上这个修复版本、重新扫描一次曲库，
        // 也能自动收敛回一份干净的记录，不需要管理员手动一条条去重。
        const dupRows = db.prepare('SELECT id, filename, play_count FROM songs WHERE filepath = ? ORDER BY play_count DESC, id ASC').all(f);
        if (dupRows.length > 0) {
          const keep = dupRows[0];
          if (keep.filename !== rel) {
            try {
              db.prepare('UPDATE songs SET filename = ?, source_root = ?, is_network = ? WHERE id = ?')
                .run(rel, root.dir, root.isNetwork ? 1 : 0, keep.id);
              retagged++;
            } catch (e) {
              console.error(`曲库扫描-重新关联失败(id=${keep.id}, filepath=${f}): ${e.message}`);
              continue;
            }
          }
          for (let i = 1; i < dupRows.length; i++) {
            try {
              deleteSongCascade(dupRows[i].id);
              mergedDup++;
              console.log(`曲库扫描: 发现同一物理文件的重复曲目记录，已合并清理 id=${dupRows[i].id}(保留 id=${keep.id})，文件: ${f}`);
            } catch (e) {
              console.error(`曲库扫描-清理重复记录失败(id=${dupRows[i].id}): ${e.message}`);
            }
          }
          existingSet.add(rel);
          continue;
        }
        try {
          const isStrmFile = path.extname(f).toLowerCase() === STRM_EXT;
          const { artist, title, language, genre } = parseFilename(f);
          // 先插入一行占位记录(audio_tracks 先留空)，拿到数据库真正分配的
          // songId 之后，缓存/探测都用这个真实 id 关联——不需要搞"临时占位id
          // 再重新挂到真实id"这种额外复杂度；哪怕缓存/探测这一步中途失败或
          // 者进程被重启，这行记录已经在库里了(cache_status 会停在
          // 'pending'/'caching')，下次扫描时会被下面"补全老曲目音轨数"那段
          // 逻辑自动重新拾起、重试，不会丢失、也不会重复插入(filename 唯一
          // 约束保证)。
          // Bug修复(网盘/网络挂载曲库扫描把整库下载到本地)：这里原来对
          // is_network 曲目用的是 'pending'('这一轮扫描马上就会被探测')，
          // 跟 STRM 曲目特意用的 'unresolved'('要等到点歌才第一次被处理')
          // 区分开——但下面探测这一步(resolveProbePath -> sourceCache.
          // ensureCached())对网络路径是"整份文件拷贝到本地"，这意味着每次
          // 扫描都会把网络曲库里*所有*曲目全部下载一遍到 /data/source-cache，
          // 只是为了跑一次 ffprobe 拿音轨数——网盘/云盘挂载的曲库体积一大，
          // 直接把硬盘写满，且完全违背"缓存只在真正点播时才发生"的设计初衷
          // (这个设计初衷本身写在 sourceCache.js 顶部注释和 STRM 相关注释里，
          // 之前只给 STRM 曲目落实了，网络挂载曲目这条路径漏改了)。
          // 现在统一成is_network 曲目跟 is_strm 曲目完全同一套处理：扫描阶段
          // 只登记文件名/标题/歌手，不碰源文件、不落地缓存、audio_tracks 留空，
          // cache_status 也统一用 'unresolved'；真正的探测+缓存挪到用户点歌
          // 加入队列的那一刻(ensureProbedOnDemand()，index.js 的
          // POST /api/queue 已经在调用，逻辑本来就支持 is_network，不需要
          // 额外改动)，这样磁盘上只会缓存"真的被点过"的那些歌。
          const r = insert.run({
            title,
            artist,
            language: language || null,
            genre: genre || null,
            filename: rel,
            filepath: f,
            audio_tracks: null,
            source_root: root.dir,
            is_network: root.isNetwork ? 1 : 0,
            is_strm: isStrmFile ? 1 : 0,
            cache_status: (isStrmFile || root.isNetwork) ? 'unresolved' : 'none',
          });
          if (r.changes > 0) {
            added++;
            const songId = r.lastInsertRowid;
            syncSongArtists(songId, artist);
            // 需求(网盘STRM支持)+Bug修复(网盘整库被扫描下载)：STRM 曲目和
            // 网络挂载(is_network)曲目在扫描阶段到此为止——都不调用
            // resolveProbePath/probeAudioTracks，不触碰网盘内容(不管是
            // .strm 指向的地址，还是网络挂载路径本身)，标题/歌手已经能正常
            // 展示和被搜到，音轨数留空，等真正被点歌加入队列时才第一次
            // 下载+探测(index.js 的 POST /api/queue 里调用
            // ensureProbedOnDemand())。只有本地曲库(is_network=0)才在扫描
            // 阶段就地探测——本地磁盘 IO 快，扫描顺带探测不会有额外磁盘占用
            // 问题。
            if (!isStrmFile && !root.isNetwork) {
              try {
                const probePath = await resolveProbePath(songId, f, root.isNetwork);
                const { tracks, audioNeedsSoft, videoNeedsSoft } = await probeAudioTracks(probePath);
                db.prepare('UPDATE songs SET audio_tracks = ?, audio_needs_soft = ?, video_needs_soft = ? WHERE id = ?').run(tracks, audioNeedsSoft, videoNeedsSoft, songId);
              } catch (e) {
                // 缓存/探测失败：这行记录已经入库(标题/歌手已经可以正常展示、
                // 点歌)，只是 audio_tracks 留空、网络文件的 cache_status 会停在
                // sourceCache.js 里记录的失败状态，下次扫描的"音轨补全"阶段会
                // 自动重试，不需要人工干预，也不影响这首歌当前已经能被搜索到。
                console.error('曲库扫描-新曲目缓存/探测失败(' + rel + '):', e.message);
              }
            }
          }
        } catch (e) {
          console.error('曲库扫描-新增文件入库失败(' + rel + '):', e.message);
        }
      }
      await yieldToEventLoop();
    }
  }

  // 兼容旧版本升级：把之前没探测过(audio_tracks为空)的老曲目补一遍。同样逐条
  // 处理并让出事件循环，避免老曲目数量很多时这一步又变成新的阻塞点。
  // 需求(网盘STRM支持)+Bug修复(网盘整库被扫描下载)：这里必须同时排除
  // is_strm=1 和 is_network=1 的曲目——否则这两类曲目的 audio_tracks 天然
  // 是 NULL(扫描阶段特意不探测，见上面插入新曲目那一段)，每次扫描都会被
  // 这段"补全老曲目音轨数"逻辑当成"待补全"重新捞出来、对全部曲目触发一次
  // 下载+探测，等于完全绕过了"只有点歌才下载"这个目标——这正是网盘/网络
  // 挂载曲库被整库扫描下载到 /data/source-cache、把硬盘写满的根因。
  // 这两类曲目的探测只应该发生在 ensureProbedOnDemand()(点歌加入队列时)。
  try {
    const pending = db.prepare("SELECT id, filepath, is_network FROM songs WHERE audio_tracks IS NULL AND is_strm = 0 AND is_network = 0").all();
    const upd = db.prepare('UPDATE songs SET audio_tracks = ?, audio_needs_soft = ?, video_needs_soft = ? WHERE id = ?');
    for (const row of pending) {
      try {
        const probePath = await resolveProbePath(row.id, row.filepath, !!row.is_network);
        const { tracks, audioNeedsSoft, videoNeedsSoft } = await probeAudioTracks(probePath);
        upd.run(tracks, audioNeedsSoft, videoNeedsSoft, row.id);
      } catch (e) {
        console.error('曲库扫描-音轨补全失败(id=' + row.id + '):', e.message);
      }
      await yieldToEventLoop();
    }
  } catch (e) {
    console.error('曲库扫描-音轨补全阶段失败:', e.message);
  }

  // 需求(全盘重新探测音轨排除网络曲库)：上面那段"补全老曲目音轨数"特意排除了
  // is_network=1/is_strm=1，是为了不让整库扫描/管理员触发的全量重新探测顺带
  // 把网盘曲库全部下载缓存一遍(见上面那段注释)。但网络/STRM 曲目里有一部分
  // 其实已经因为之前点过歌/播过而缓存到本地了(cache_status='ready' 且缓存
  // 文件还在)——这部分完全没必要因为"是网络曲库"就被一刀切跳过：探测这些
  // 已经躺在本地磁盘上的文件不需要碰网络、不会触发任何新下载，是真正"免费"
  // 的补全，跳过反而是浪费。这里单独加一段，只认"确实已经缓存好"的网络/STRM
  // 曲目，直接对本地缓存文件跑 probeAudioTracks()——特意不走
  // resolveProbePath()/sourceCache.ensureCached()，因为那条路径会做"缓存是否
  // 新鲜"校验，一旦源文件在网盘那边被替换过导致校验不通过，就会触发重新下载，
  // 这正是这个需求要避免的；这里只想"用现成的本地文件探测一次"，源文件是否
  // 变了不在这一步的关心范围内(如果确实变了，等用户下次点这首歌播放时，
  // 播放路径本来就会走 ensureCached() 的新鲜度校验，自然会重新下载，不依赖
  // 这里)。
  try {
    const pendingCached = db.prepare(
      "SELECT id, cache_path FROM songs WHERE audio_tracks IS NULL AND (is_network = 1 OR is_strm = 1) AND cache_status = 'ready' AND cache_path IS NOT NULL"
    ).all();
    const updCached = db.prepare('UPDATE songs SET audio_tracks = ?, audio_needs_soft = ?, video_needs_soft = ? WHERE id = ?');
    for (const row of pendingCached) {
      try {
        // 双重保险：数据库说 cache_status='ready'，但缓存目录可能被
        // cacheCleaner.js 按最大容量/最长存放天数清理掉了(这两个动作跟这里
        // 完全异步、互不通气)，实际探测前再确认一次文件真的还在，不在的话
        // 跳过——绝不因为这个补全步骤去触发重新下载，跳过的曲目留到用户
        // 下次点歌播放时按正常播放路径自然重新缓存+探测。
        if (!row.cache_path || !fs.existsSync(row.cache_path)) continue;
        const { tracks, audioNeedsSoft, videoNeedsSoft } = await probeAudioTracks(row.cache_path);
        updCached.run(tracks, audioNeedsSoft, videoNeedsSoft, row.id);
      } catch (e) {
        console.error('曲库扫描-网络曲库音轨补全(仅本地缓存)失败(id=' + row.id + '):', e.message);
      }
      await yieldToEventLoop();
    }
  } catch (e) {
    console.error('曲库扫描-网络曲库音轨补全(仅本地缓存)阶段失败:', e.message);
  }

  // 兼容旧版本升级：老曲目在引入"语种/风格"字段之前入库，这两列必然都是
  // NULL，这里按文件名重新解析一次，只回填 language/genre，不touch已经
  // 存在的 title/artist（避免覆盖后台可能已经手动编辑过的歌名/歌手）。
  // 只处理 language 和 genre 同时为 NULL 的行，回填过一次之后（哪怕解析
  // 结果是空字符串）就不会再被这段逻辑重复处理。
  try {
    const pendingLG = db.prepare('SELECT id, filepath FROM songs WHERE language IS NULL AND genre IS NULL').all();
    const updLG = db.prepare('UPDATE songs SET language = ?, genre = ? WHERE id = ?');
    for (const row of pendingLG) {
      try {
        const parsed = parseFilename(row.filepath);
        updLG.run(parsed.language || '', parsed.genre || '', row.id);
      } catch (e) {
        console.error('曲库扫描-语种/风格补全失败(id=' + row.id + '):', e.message);
      }
      await yieldToEventLoop();
    }
  } catch (e) {
    console.error('曲库扫描-语种/风格补全阶段失败:', e.message);
  }

  // 清理已不存在的文件记录：这一步只有本地数据库增删操作，没有 ffprobe 这类
  // 耗时 IO，不是本次"渐进式"要解决的瓶颈，保持原有一次性事务写法。
  // 需求(本地mv多路径支持)延伸出的安全防护：一首歌只有在"它所属的那个根目录
  // 这一轮确实被成功扫描到了、但文件已经不在里面"的情况下才会被判定为已删除；
  // 如果它所属的根目录这一轮本来就不可访问(挂载失败/网络断开)，不管
  // allCurrentFilenames 里有没有它，都不清理——避免一个网盘暂时掉线就把它
  // 名下的曲目全部误删。source_root 为空(升级前的老记录，早于本次多路径改动)
  // 一律按第一个本地目录(MV_DIR)处理，保持跟改动前完全一致的行为。
  //
  // 需求(扫描方式拆分 + 启动期误删防护)：
  //   - mode='incremental' 时这一步整体跳过，不删任何记录(见函数顶部注释)。
  //   - mode='full' 时新增一层"骤减熔断"：只做"目录整个不可访问"的保护还不
  //     够——网盘/网络挂载在容器刚启动时可能出现"挂载点目录本身存在(所以
  //     fs.existsSync 判定为 true)，但里面还是空的/只有一部分文件"这种中间
  //     状态，这种情况在文件系统层面跟"文件真的被用户删除了"完全没区别，
  //     必须靠"这一轮消失的比例是否反常"来兜底识别，而不是单纯信任
  //     fs.existsSync。按 source_root 分组：如果某个根目录名下这一轮判定
  //     "消失"的曲目数量占该目录曲目总数的比例达到/超过 DELETE_SAFETY_RATIO
  //     (且该目录曲目总数不低于 DELETE_SAFETY_MIN_SONGS，避免曲库本来就很小
  //     时正常删一两首歌就被误挡)，这一轮直接跳过对这个根目录的删除，只记
  //     日志+计入返回值里的 safetyBlocked，不执行任何 deleteSongCascade——
  //     管理员确认目录/挂载确实恢复正常后，再手动点一次"全量扫描"即可正常
  //     生效，避免"网盘一次抖动/容器一次重启时机不巧，整个曲库记录被清零"
  //     这种不可逆事故。
  const DELETE_SAFETY_RATIO = 0.5;
  const DELETE_SAFETY_MIN_SONGS = 20;
  const accessibleRootDirs = new Set(perRoot.filter(r => r.accessible).map(r => r.root.dir));
  let removed = 0;
  const safetyBlocked = []; // [{ rootDir, totalInRoot, wouldRemove }]
  if (mode !== 'incremental') {
    try {
      const all = db.prepare('SELECT id, filename, source_root FROM songs').all();
      // 先按根目录分组统计"这一轮总共有多少首、其中多少首会被判定为消失"，
      // 用于上面说的骤减熔断判断；分组统计本身不产生任何数据库写操作。
      const byRoot = new Map(); // rootDir -> { total, missing: row[] }
      for (const row of all) {
        const rootDir = row.source_root || getMVDir();
        if (!accessibleRootDirs.has(rootDir)) continue; // 这个根目录本轮不可访问，安全起见跳过，不清理
        if (!byRoot.has(rootDir)) byRoot.set(rootDir, { total: 0, missing: [] });
        const bucket = byRoot.get(rootDir);
        bucket.total++;
        if (!allCurrentFilenames.has(row.filename)) bucket.missing.push(row);
      }
      // 删除逻辑(级联清 queue/history/favorites/song_artists 再删 songs、顺带
      // 清 HLS 产物和本地缓存副本)统一走 deleteSongCascade()，不在这里重复写一份——
      // 避免出现"这里改对了、管理后台手动删除接口忘记跟着改"这种两处逻辑不
      // 同步的问题(问题3的第一部分根因)。
      for (const [rootDir, bucket] of byRoot) {
        if (bucket.missing.length === 0) continue;
        const ratio = bucket.missing.length / bucket.total;
        if (bucket.total >= DELETE_SAFETY_MIN_SONGS && ratio >= DELETE_SAFETY_RATIO) {
          console.error(
            `曲库扫描-骤减熔断: 目录 ${rootDir} 本轮判定消失 ${bucket.missing.length}/${bucket.total} 首` +
            `(占比${(ratio * 100).toFixed(0)}%)，疑似网络挂载/网盘还没真正生效或临时抖动，` +
            `本轮跳过对这个目录的删除操作(不删任何记录)，确认目录恢复正常后请手动重新执行「全量扫描」`
          );
          safetyBlocked.push({ rootDir, totalInRoot: bucket.total, wouldRemove: bucket.missing.length });
          continue;
        }
        for (const row of bucket.missing) {
          try {
            deleteSongCascade(row.id);
            removed++;
          } catch (e) {
            // 单条记录删除失败（如HLS缓存目录权限问题）只记日志、跳过，不影响其余记录清理
            console.error('曲库扫描-删除已缺失曲目失败(id=' + row.id + '):', e.message);
          }
        }
      }
    } catch (e) {
      console.error('曲库扫描-清理缺失文件阶段失败:', e.message);
    }
  }

  // Bug修复(问题3 "未缓存完成的网盘歌曲文件丢失后曲库删不掉/数量对不上"的
  // 第二部分——重新扫描也清不掉)：上面"清理已不存在的文件记录"这一步，判断
  // 一首歌是否还存在，测的是它在本地的那个文件——对本地曲库/纯网络挂载曲库
  // 这没问题，但对 STRM 曲目，本地真正存在的是那个几十字节的 .strm 指针
  // 文件本身，它指向的网盘目标是否还在，这一步根本不会去看。指针文件不会
  // 因为网盘上真实的源文件被删除/挪走而消失，导致这种"已确认失联"的 STRM
  // 曲目永远不会被上面那段逻辑判定为需要清理，重新扫描多少次都清不掉。
  //
  // 这里只针对 cache_status='failed' 的网络挂载/STRM 曲目(即：已经真的有人
  // 点过/预热过、真的尝试连过一次网盘或直链、确认失败过至少一次，不是凭空
  // 猜测)，每次扫描时用一次轻量的 stat/HEAD 请求(sourceCache.getSourceStat，
  // 不下载正文)重新确认一次源是否可达：
  //   - 依然不可达 -> 判定为真正丢失，跟"文件已从目录消失"走同一套级联删除
  //     逻辑清理掉，曲库数量、"能不能被彻底删除"这两个问题一起解决；
  //   - 这次反而可达了(比如之前只是网络抖动) -> 只把 cache_status 重置回
  //     'pending'，留给下次播放/预热重新尝试真正落地缓存，不在扫描阶段就
  //     发起一次完整下载(保持扫描本身轻量、不阻塞的既定原则)。
  //
  // 需求(扫描方式拆分)：这一步同样会执行 deleteSongCascade，为了让
  // mode='incremental' "这一轮绝不删任何记录"的承诺完全成立，这里也要跳过。
  if (mode !== 'incremental')
  try {
    const failedNetworkSongs = db.prepare(
      "SELECT id, filename, filepath FROM songs WHERE cache_status = 'failed' AND (is_network = 1 OR is_strm = 1)"
    ).all();
    for (const row of failedNetworkSongs) {
      try {
        const srcInput = sourceCache.resolveSourceInput(row.filepath);
        await sourceCache.getSourceStat(srcInput);
        // 源这次确认可达，大概率是之前的网络抖动，不是真的丢失，重置状态
        db.prepare("UPDATE songs SET cache_status = 'pending' WHERE id = ?").run(row.id);
      } catch (e) {
        console.error('曲库扫描-网盘/STRM源已确认丢失，清理曲目(id=' + row.id + ' "' + row.filename + '"):', e.message);
        try {
          deleteSongCascade(row.id);
          removed++;
        } catch (e2) {
          console.error('曲库扫描-清理已确认丢失的网盘曲目失败(id=' + row.id + '):', e2.message);
        }
      }
      await yieldToEventLoop();
    }
  } catch (e) {
    console.error('曲库扫描-网盘/STRM失联校验阶段失败:', e.message);
  }

  if (retagged > 0 || mergedDup > 0) {
    console.log(`曲库扫描: 本轮因曲库来源配置变化重新关联了 ${retagged} 首曲目的所属目录，合并清理了 ${mergedDup} 条重复记录`);
  }
  if (safetyBlocked.length > 0) {
    console.log(`曲库扫描: 本轮有 ${safetyBlocked.length} 个目录触发骤减熔断，跳过了删除，详见上面的日志`);
  }
  return { total: allCurrentFilenames.size, added, removed, retagged, mergedDup, mode, safetyBlocked };
}

// 需求(扫描方式拆分)：mode='diff' 的只读预览实现——跟 scanLibrary() 正式
// 扫描共用同一份 listAllFiles() 结果(perRoot，调用方已经拿到，不重复扫盘)，
// 但完全不碰数据库写操作、不做文件名去重合并、不触发探测/网络挂载 IO，
// 只是拿"这一轮看到的文件名集合"跟"数据库里已有的文件名集合"做一次纯内存
// 比较，尽量快地告诉管理员"如果现在执行全量扫描，会新增哪些、会删除哪些"。
// 返回结构刻意跟 scanLibrary() 的正常返回对齐(total/added/removed 三个数字
// 语义一致)，方便管理后台复用同一套展示逻辑，额外带上 toAdd/toRemove 两份
// 明细清单(toRemove 只带 id/filename，不含隐私敏感字段，且做了跟正式删除
// 一样的"根目录不可访问则不计入"保护，只是这里"不计入"改成"不出现在预览
// 里"，语义仍然一致)。
function runDiffPreview(perRoot) {
  const accessibleRootDirs = new Set(perRoot.filter(r => r.accessible).map(r => r.root.dir));
  const allCurrentFilenames = new Set();
  const toAdd = [];
  for (const { root, files } of perRoot) {
    for (const f of files) {
      const rel = `${root.tag}::${path.relative(root.dir, f)}`;
      allCurrentFilenames.add(rel);
    }
  }
  const existingRows = db.prepare('SELECT id, filename, title, artist, source_root, filepath FROM songs').all();
  const existingSet = new Set(existingRows.map(r => r.filename));
  for (const { root, files } of perRoot) {
    for (const f of files) {
      const rel = `${root.tag}::${path.relative(root.dir, f)}`;
      if (!existingSet.has(rel)) toAdd.push({ filename: rel, filepath: f });
    }
  }
  const toRemove = [];
  for (const row of existingRows) {
    const rootDir = row.source_root || getMVDir();
    if (!accessibleRootDirs.has(rootDir)) continue; // 目录本轮不可访问，预览里也不当"会被删除"处理，跟正式扫描保护逻辑一致
    if (!allCurrentFilenames.has(row.filename)) {
      toRemove.push({ id: row.id, filename: row.filename, title: row.title, artist: row.artist, source_root: rootDir });
    }
  }
  // 按根目录分组统计一下比例，方便管理后台直接判断"这次预览里有没有反常骤减"，
  // 不需要自己再算一遍——跟正式扫描的骤减熔断用同一套阈值，保持口径一致。
  const byRoot = new Map();
  for (const row of existingRows) {
    const rootDir = row.source_root || getMVDir();
    if (!accessibleRootDirs.has(rootDir)) continue;
    if (!byRoot.has(rootDir)) byRoot.set(rootDir, { total: 0, missing: 0 });
    byRoot.get(rootDir).total++;
  }
  for (const r of toRemove) {
    const bucket = byRoot.get(r.source_root);
    if (bucket) bucket.missing++;
  }
  const suspicious = [...byRoot.entries()]
    .filter(([, b]) => b.total >= 20 && b.missing / b.total >= 0.5)
    .map(([rootDir, b]) => ({ rootDir, totalInRoot: b.total, wouldRemove: b.missing }));
  return {
    mode: 'diff',
    total: allCurrentFilenames.size,
    added: toAdd.length,
    removed: toRemove.length,
    toAdd,
    toRemove,
    suspicious,
  };
}

// 需求(网盘STRM支持)：STRM 曲目在扫描阶段被特意跳过的探测，挪到这里——第
// 一次被点歌加入队列时才调用。逻辑跟 scanLibrary() 里对非 STRM 新曲目做的
// 事完全一样(resolveProbePath 解析真实源地址+落地缓存，再 probeAudioTracks
// 探测音轨数)，只是触发时机从"扫描"改成"点歌"。
// 供 index.js 的 POST /api/queue 调用；调用方负责异步调用、不等待，不阻塞
// 点歌接口的响应。
// song 需要至少包含 id/filepath/is_network/is_strm/audio_tracks 字段(数据库
// 里 songs 表整行即可)。audio_tracks 已经探测过时直接跳过，不重复下载/探测——
// 避免同一首歌被反复点、每次都重新触发一轮探测。
//
// Bug修复(问题2 "点重新探测音轨直接报错"，及其暴露的第二个bug)：管理后台
// "重新探测音轨"(单曲/批量)两个接口原来的代码直接对 song.filepath 跑
// probeAudioTracks()——既没 await(probeAudioTracks 是 async 函数，拿到的
// 是还没 resolve 的 Promise，直接塞给 SQLite 绑定参数触发
// "TypeError: SQLite3 can only bind numbers, strings, bigints, buffers, and
// null")，也完全没走 STRM/网络挂载该走的"先解析真实源地址、落地缓存"这一步
// (直接对 .strm 这个几十字节的文本指针文件跑 ffprobe，必然
// "Invalid data found when processing input")。现在统一改成调用这一个探测
// 入口，接口那边只需要 await 它、不用再关心 STRM/缓存细节。
// 新增 force 参数：
//   - 不传/false(点歌触发那条路径，见 index.js POST /api/queue)：保持原有
//     "已经探测过(audio_tracks != null)就跳过"的行为，不重复探测。
//   - true(管理后台"重新探测"传)：无视已有值，强制重新走一遍完整的
//     STRM/网络挂载解析 + 探测流程。
// 并发去重：同一首歌的探测(不管是 force 还是非 force 触发)如果已经有一个
// 在跑，后来的调用直接复用同一个 Promise，不会重复起 ffprobe 进程/重复拷贝
// 网络文件——避免点歌触发的按需探测、播放触发的按需探测(问题1修复)、管理员
// 手动重探这三条路径撞在同一首歌上时被并发跑好几次、抢占资源。
const probingInflight = new Map(); // songId -> Promise<number|null>
async function ensureProbedOnDemand(song, force = false) {
  if (!song) return null;
  if (!force && song.audio_tracks != null) return song.audio_tracks;
  if (probingInflight.has(song.id)) return probingInflight.get(song.id);
  const p = (async () => {
    const needsCache = !!(song.is_network || song.is_strm);
    const probePath = await resolveProbePath(song.id, song.filepath, needsCache);
    const { tracks: audio_tracks, audioNeedsSoft, videoNeedsSoft } = await probeAudioTracks(probePath);
    db.prepare('UPDATE songs SET audio_tracks = ?, audio_needs_soft = ?, video_needs_soft = ? WHERE id = ?').run(audio_tracks, audioNeedsSoft, videoNeedsSoft, song.id);
    return audio_tracks;
  })();
  probingInflight.set(song.id, p);
  try {
    return await p;
  } finally {
    probingInflight.delete(song.id);
  }
}

// Bug修复(问题3 "未缓存完成的网盘歌曲文件丢失后曲库删不掉/数量对不上"的
// 第一部分——删除本身失败)：queue 表对 songs.id 有真实的 FOREIGN KEY 约束
// (song_artists 同样有)。queue 表里"已播完"的历史记录只会被标记
// status='done'，从来不会真的删除——这些悬空引用一直存在，导致直接
// "DELETE FROM songs"在这首歌曾经被点过的情况下必然撞上
// "FOREIGN KEY constraint failed"，删除失败、曲库计数也就跟着对不上。
// history/favorites 虽然 schema 里没写真正的 FOREIGN KEY，但同样是指向被
// 删歌曲的悬空引用，一并清理，避免后续查询/展示出问题。
// 这个函数统一了"一首歌到底该怎么被彻底删除"这套逻辑，供 scanLibrary() 的
// 自动清理和管理后台"删除歌曲"接口共用——避免再次出现"自动清理那边改对了，
// 管理员手动删除那个接口忘记跟着改"这种两处逻辑不同步的问题。
function deleteSongCascade(id) {
  const row = db.prepare('SELECT cache_path FROM songs WHERE id = ?').get(id);
  const delQueue = db.prepare('DELETE FROM queue WHERE song_id = ?');
  const delHistory = db.prepare('DELETE FROM history WHERE song_id = ?');
  const delFavorites = db.prepare('DELETE FROM favorites WHERE song_id = ?');
  const delArtists = db.prepare('DELETE FROM song_artists WHERE song_id = ?');
  const del = db.prepare('DELETE FROM songs WHERE id = ?');
  const tx = db.transaction((songId) => {
    delQueue.run(songId);
    delHistory.run(songId);
    delFavorites.run(songId);
    delArtists.run(songId);
    del.run(songId);
  });
  tx(id);
  removeHLS(id);
  // 源文件已经不在了/歌曲被删了，它在本地的缓存副本(如果有)也一起清掉，
  // 不留孤儿缓存文件占磁盘。
  if (row && row.cache_path) {
    try { fs.rmSync(row.cache_path, { force: true }); } catch (e) { /* 忽略 */ }
  }
}

module.exports = {
  scanLibrary, probeAudioTracks, probeDurationAsync, ensureProbedOnDemand, deleteSongCascade,
  parseFilename, splitArtists, syncSongArtists, isProblemAudioCodec, isProblemVideoCodec,
  getMVDir, getMVRoots, getLibraryRoots, saveLibraryRoots, resolveLibraryRootPath, BASE_MOUNTS,
};
