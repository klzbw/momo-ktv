// ============ 模块：已点队列后台预加载 ============
// 需求：已点(队列)列表加入后台预加载功能，提前进行转码和读取时长等信息。
//
// 背景：在这次改动之前，转码(ensureHLS)只在 TV 端真正请求
// /hls/:id/master.m3u8（也就是这首歌切到"正在播放"、播放器发起加载）时才
// 触发；时长(songs.duration)更是全程没有任何地方探测过、一直是 NULL。这意味着
// 用户在已点队列里排在后面的歌，只有真正轮到播放的那一刻才开始转码——如果
// 是纯软件编码(libx264)且 MV 文件较大，用户点开播放器仍然会经历几秒到几十秒
// 的转圈等待；已点列表里也没法提前显示时长。
//
// 方案：队列发生变化（新增点歌/删除/切歌/置顶——任何可能改变"接下来会播放
// 哪几首"的操作）时调用 schedulePreload()，对"正在播放" + 紧随其后的
// PRELOAD_AHEAD 首"等待中"歌曲组成的预热窗口，后台异步做两件事：
//   1) 调 hlsgen 的 ensureHLS() 提前触发转码——ensureHLS 内部本身就会判断
//      "缓存已是最新"或"已有任务在后台跑"就直接跳过，所以对同一首歌重复
//      调用是安全的、不会重复起转码任务。
//   2) 对 duration 还是 NULL 的歌用 ffprobe 异步探测时长并回写数据库，成功
//      后通过 WebSocket 广播队列更新，前端已点列表能实时补上时长显示。
// 只预热紧邻的几首而不是一次性预热整条队列，是为了避免队列很长时一口气
// 塞进几十个并发转码任务，把机器（尤其是没有硬件加速、纯软件编码）拖垮，
// 反而影响正在播放这首歌的转码/播放体验；随着播放推进、队列往前滚动，
// 预热窗口也会跟着往后移动，后面的歌到时候一样会被提前预热到。
const db = require('./db');
const log = require('./logger');
const { ensureHLS } = require('./hlsgen');
const { probeDurationAsync, ensureProbedOnDemand } = require('./scanner');
const sourceCache = require('./sourceCache');

const PRELOAD_AHEAD = 2; // 除"正在播放"外，额外预热紧随其后的等待中歌曲数量

// 时长探测是异步的，同一首歌可能在探测结果落地前又被 schedulePreload() 命中
// 一次（比如短时间内连续点歌/删歌触发多次调用）——用这个集合去重，避免对
// 同一首歌并发起多个 ffprobe 探测进程。
const probingDuration = new Set();

// 队列/时长有更新时用来通知前端的回调，由 index.js 通过
// setPreloadUpdateNotifier() 注入（实际就是那边的 broadcastQueue()），
// 这里不直接依赖 index.js，避免循环 require。
let onUpdate = null;
function setPreloadUpdateNotifier(fn) {
  onUpdate = fn;
}

// ---------- 客户端解码模式感知 ----------
// Bug修复：schedulePreload() 原来完全不知道当前播放端(Android/TV 客户端)
// 选的是"硬解"(客户端直连 /stream/:id 原始文件，由设备硬件解码器解码，服务端
// 不参与转码)还是"软解"(客户端走 /hls/:id/master.m3u8，需要服务端 ensureHLS
// 转码)，导致不管客户端是哪种模式，预热窗口里的歌一律无条件调用 ensureHLS
// 转码——硬解模式下这些转码结果客户端根本用不上(硬解请求走的是 /stream 直连
// 原始文件，不会去读 HLS 输出)，白白占用 CPU/GPU 和磁盘 IO，还可能因为并发
// 转码任务过多反而拖慢真正需要转码的场景。
// 现在由 index.js 在收到 Android 客户端的 /api/decode-mode/report 上报时
// 调用 setDecodeMode() 把当前模式同步过来，schedulePreload() 据此决定要不要
// 触发转码；时长探测(preloadDuration)与解码模式无关，两种模式下已点列表都
// 需要显示时长，所以不受这个开关影响，始终照常探测。
// 默认值与 Android 客户端 Prefs.getDecodeMode() 的默认值(SOFTWARE)保持一致：
// 服务端重启后、真正收到第一次上报之前，按"软解"处理正常转码，避免误判成
// "硬解、不用预热"反而导致软解播放时要现等转码。
let clientDecodeMode = 'software';
function setDecodeMode(mode) {
  if (mode !== 'hardware' && mode !== 'software') return; // 忽略未知/空值，保留上一次已知状态
  const changed = clientDecodeMode !== mode;
  clientDecodeMode = mode;
  // 从硬解切回软解：预热窗口里的歌此前因为处于硬解模式被跳过了转码预热，
  // 这里补触发一次调度，避免真正播放到这些歌时才发现还没转码、要现等。
  if (changed && mode === 'software') schedulePreload();
}

function pickPreloadTargets() {
  // 排序逻辑跟 index.js 的 getQueueWithSongs() 保持一致（正在播放的排最前，
  // 其次按 top_order 排——数值越大表示置顶得越晚、排越前，NULL 表示从没
  // 被置顶过、排在所有置顶过的行之后，再按点歌顺序 id ASC），只取预热窗口
  // 需要的这几行，附带 songs 表的完整字段（ensureHLS 需要 filepath/
  // audio_tracks，探测时长需要 filepath）。
  return db.prepare(`
    SELECT s.*
    FROM queue q JOIN songs s ON q.song_id = s.id
    WHERE q.status != 'done'
    ORDER BY (q.status='playing') DESC, (q.top_order IS NULL) ASC, q.top_order DESC, q.id ASC
    LIMIT ?
  `).all(PRELOAD_AHEAD + 1);
}

function preloadTranscode(song) {
  const songTag = `id=${song.id} "${song.title || song.filename}"`;
  Promise.resolve()
    .then(async () => {
      // Bug修复(双音轨被误判成单音轨的竞态，第二处触发点)：后台预热转码
      // 跟真正的 /hls/:id/master.m3u8 请求一样，都是"真正会触发转码"的
      // 地方——如果这首歌是 STRM/网络挂载曲目、探测还没落地就先跑到这里，
      // ensureHLS() 同样会把它当单音轨误判。这里也补上同一步：先 await
      // 一次探测完成，已经探测过的歌不受影响、不会多等。ensureProbedOnDemand
      // 内部的并发去重保证跟点歌触发的探测、/hls 路由触发的探测不会重复跑。
      if (song.audio_tracks == null && (song.is_network || song.is_strm)) {
        song.audio_tracks = await ensureProbedOnDemand(song);
      }
      return ensureHLS(song);
    })
    .then(() => log.info('PRELOAD', `已点队列后台预热转码已触发(${songTag})`))
    .catch(e => log.warn('PRELOAD', `已点队列后台预热转码失败(${songTag}): ${e.message}`));
}

function preloadDuration(song) {
  if (song.duration != null) return; // 已经探测过，不用重复读
  if (probingDuration.has(song.id)) return; // 上一次探测还没落地，先不重复起进程
  probingDuration.add(song.id);
  const songTag = `id=${song.id} "${song.title || song.filename}"`;
  // 网络挂载曲库优先探测本地缓存副本(没缓存好就退回网络路径兜底，见
  // sourceCache.resolvePlaybackPath())，本地曲库不受影响。
  // 需求(网盘STRM支持)：STRM 曲目缓存还没就绪时 srcPath 会是 null(见
  // resolvePlaybackPath() 的注释)，这里不硬起一个注定失败的 ffprobe 进程，
  // 直接跳过本轮——同一首歌只要还在预热窗口里，队列每次变化都会重新调用
  // schedulePreload()，缓存就绪后自然会被重新捞到探测，不需要额外重试逻辑。
  const { path: srcPath } = sourceCache.resolvePlaybackPath(song);
  if (!srcPath) { probingDuration.delete(song.id); return; }
  probeDurationAsync(srcPath)
    .then(seconds => {
      if (seconds == null) return;
      db.prepare('UPDATE songs SET duration=? WHERE id=?').run(seconds, song.id);
      log.info('PRELOAD', `已点队列后台预读时长完成(${songTag}): ${seconds}s`);
      if (onUpdate) onUpdate();
    })
    .catch(e => log.warn('PRELOAD', `已点队列后台预读时长失败(${songTag}): ${e.message}`))
    .finally(() => probingDuration.delete(song.id));
}

// 供 index.js 在"任何可能改变接下来要播放哪几首歌"的队列操作之后调用
// （新增点歌、删除、切歌、置顶）。函数本身只负责"发起"预热，不等待转码/
// 探测完成，调用方（HTTP 路由）不会被这里拖慢响应时间。
function schedulePreload() {
  let targets;
  try {
    targets = pickPreloadTargets();
  } catch (e) {
    log.error('PRELOAD', `读取已点队列预热目标失败: ${e.message}`);
    return;
  }
  for (const song of targets) {
    // 硬解模式下客户端直连原始文件由设备硬件解码器解码，根本不会请求
    // /hls/:id/master.m3u8，这里转出来的 HLS 分片大多数情况下用不上，可以
    // 跳过；但以下几种"客户端硬解本来就走不通、会被 PlayerManager.
    // effectiveModeFor() 强制转去软解播放"的歌是例外，不管当前全局解码模式
    // 是什么都要照常预热转码，否则用户点到这首歌时还要现等 ensureHLS 转码：
    //   - 单音轨(可能是"声道型"伴唱/原唱分声道的老编码，靠软解走服务端声道
    //     分离虚拟音轨才能支持原/伴唱切换)
    //   - audio_needs_soft(音频编码硬解大概率没声音，如 mp2)
    //   - video_needs_soft(需求修复"RV40硬解黑屏，声音正常"：视频编码硬解
    //     大概率黑屏，如 RV40，这两个标记之前预热逻辑完全没考虑，会导致这类
    //     歌哪怕已经被服务端标记了"必须软解"，第一次点到时依然要现场等
    //     ensureHLS 转码完才能开始播放)
    // 时长探测和解码模式无关，始终照常做。
    const isSingleTrack = (song.audio_tracks || 1) < 2;
    const forcedSoftware = isSingleTrack || !!song.audio_needs_soft || !!song.video_needs_soft;
    // 网络KTV歌曲(source_root='netktv'或'netktv-mkv')：直接走302直连模式，不走HLS转码，跳过预热
    const isNetKtv = song.source_root === 'netktv' || song.source_root === 'netktv-mkv';
    if (!isNetKtv && (clientDecodeMode !== 'hardware' || forcedSoftware)) {
      preloadTranscode(song);
    }
    preloadDuration(song);
  }
}

module.exports = { schedulePreload, setPreloadUpdateNotifier, setDecodeMode };
