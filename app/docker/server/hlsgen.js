const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const log = require('./logger');
const sourceCache = require('./sourceCache');

// Bug 根本修复（原唱/伴唱切换会从头播放 + 拖进度条失效）：
// 旧方案在切换音轨时用 ffmpeg 现场把整段视频重新封装成一个新的 MP4 流吐给
// <video>，这个新响应体没有 Content-Length/Range 支持（长度未知），所以：
//   1) 切音轨 = 换了一个全新的、不可寻址的流 => 只能从头播放；
//   2) 切完音轨后拖进度条 = 在一个不支持 Range 的流上 seek => 同样只能从头。
// 新方案：把每首歌预先/按需转成 HLS（m3u8 + .ts 分片）。视频轨和每一条音频轨
// 各自独立切片、独立成一份 media playlist，再通过一份 master.m3u8 用
// #EXT-X-MEDIA 把所有音频轨声明成同一个 AUDIO group，与视频轨绑定。
// 前端用 hls.js 加载 master.m3u8 后，切换音轨只是 hls.audioTrack = 0/1 —
// hls.js 只会重新拉取音频分片，视频分片、播放位置完全不受影响；HLS 的分片
// 天然可寻址，拖进度条对任意音轨都正常工作。
//
// 单音轨文件兼容：master.m3u8 里只声明 1 条音频轨，hls.js/播放器行为等价于
// 普通单音轨 HLS 播放，不影响现有的"声道型"(单音轨里左右声道分别是伴唱/原唱)
// Web Audio 分离逻辑——那部分是在解码后的音频节点上做的，跟视频用什么方式
// 加载无关，继续保留在前端。
//
// 本次改动（首次点歌卡顿修复）解决两个问题：
//   1) 转码是纯 CPU 软件编码(libx264)，一首歌要转好几十秒到几分钟，点歌人
//      在这段时间里点开播放器只会一直转圈；现在优先用 VAAPI 硬件编解码，
//      在有核显/独显的机器上大幅缩短转码耗时，且运行时自动探测硬件是否
//      可用、不可用就自动回退到 libx264，不会因为某台机器没有 GPU 而直接
//      放弃转码或者报错。
//   2) 就算硬件转码，一首完整 MV 转完也需要一点时间；旧实现是"整首歌转完
//      -> 一次性 rename 上线 -> 才响应 master.m3u8"，本质上是阻塞式的，
//      用户点下去之后必须等整首歌转码完成才能看到画面。现在改成渐进式：
//      master.m3u8 一旦知道音轨数量就立刻可以生成并返回（不依赖转码是否
//      完成）；video/audioN 的分片使用 HLS "event" 播放列表类型，让 ffmpeg
//      一边转码一边持续追加分片和刷新子播放列表；分片/子播放列表的 HTTP
//      请求如果撞上"这一片还没转出来"，服务端会短暂轮询等待它出现再响应，
//      而不是直接 404 或者等全曲转完，从而做到"随出随播"。

// 本次改动（新增 NVIDIA 显卡转码支持）：
//   在原有 VAAPI（Intel/AMD 核显）硬件加速的基础上，新增一套独立的 NVENC
//   （NVIDIA 独显/核显）探测与编码路径，两者互不影响、可以共存。优先级为
//   NVENC > VAAPI > libx264（软件编码）——某台机器上探测到哪个就用哪个，
//   都探测不到时始终能回退到纯软件编码保证转码不失败。NVIDIA 这条路径要求
//   宿主机已经安装好 nvidia-container-toolkit 并在 docker 里注册好 nvidia
//   runtime，这是 docker 层面的前提条件，不是本文件能控制的；如果宿主机
//   没有装好这些，nvidia-smi 在容器里就会不可用，探测函数会直接判定为
//   "NVIDIA 硬件加速不可用" 并回退，不会导致转码报错。
const HLS_DIR = process.env.HLS_DIR || '/data/hls';
// AI 人声分离产物目录（separate.js 把 vocals/accompaniment wav 落在 /data/separated/<id>/）
const DATA_DIR = process.env.DATA_DIR || '/data';
const SEGMENT_TIME = 6; // 秒，只是切片建议值，ffmpeg 仍会在最近的关键帧处切割
// 纯音频(mp3/flac/wav/ape/cue分轨)没有视频画面，K 歌时需要一条背景视频轨。
// 用户可把自己的背景视频(mp4/mov/mkv/webm)放进该目录，点纯音频歌时随机挑一个
// 循环铺底；目录为空时用 ffmpeg 内置的流动渐变(gradients)动态背景，再不行用
// 静态深色兜底，保证任何情况下都有画面、且能复用整套视频 HLS 播放链路。
const BG_DIR = process.env.BG_DIR || '/data/backgrounds';
const BG_EXTS = /\.(mp4|mov|mkv|webm|m4v)$/i;
let bgCache = { at: 0, list: [] };
function pickBackgroundVideo() {
  const now = Date.now();
  if (now - bgCache.at > 30000) { // 目录列表缓存 30s，新增背景无需重启即可被选中
    bgCache.at = now;
    try {
      fs.mkdirSync(BG_DIR, { recursive: true }); // 目录不存在则创建，方便用户投放背景视频
      bgCache.list = fs.readdirSync(BG_DIR).filter(f => BG_EXTS.test(f)).map(f => path.join(BG_DIR, f));
    } catch (e) { bgCache.list = []; }
  }
  const list = bgCache.list;
  if (!list.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}

// ---------- VAAPI 硬件加速探测 ----------
const VAAPI_DEVICE = process.env.VAAPI_DEVICE || '/dev/dri/renderD128';

// 三态缓存：null=还没测过，true/false=测过的结果。避免每首歌都重新探测一次
// （探测本身要真跑一次 ffmpeg，没必要每次都做）。
let vaapiState = null;

// 只做"设备文件存在"这一层检测还不够——文件存在但驱动装错/权限不对/容器没
// 映射成功时，真正调用 h264_vaapi 编码会直接失败。所以这里额外做一次最小
// 成本的真实编码自检（1x1 帧、编码 1 帧），确保后续所有歌曲都能直接复用
// 一个可靠的判断结果，而不是每首歌自己去试错。
async function detectVAAPI() {
  if (vaapiState !== null) return vaapiState;

  log.info('VAAPI', `开始探测核显硬件加速，渲染节点: ${VAAPI_DEVICE}`);

  if (!fs.existsSync(VAAPI_DEVICE)) {
    log.warn('VAAPI', `未检测到渲染节点 ${VAAPI_DEVICE}（宿主机可能没有核显，或安装/升级时 devices 段落被自动裁掉）—— 核显调用: 失败，本次运行全程使用软件编码 (libx264)`);
    vaapiState = false;
    return false;
  }
  log.info('VAAPI', `渲染节点 ${VAAPI_DEVICE} 存在，开始做最小成本的真实编码自检（1x1帧/1帧 h264_vaapi 编码）`);

  // 顺带把 vainfo 的驱动摘要打进日志，出问题时（比如装错驱动/权限不对）一眼就能看出来，
  // 这一步失败不影响后续判断，只是尽力而为的诊断信息。
  try {
    const info = execFileSync('vainfo', { timeout: 8000 }).toString();
    const driverLine = info.split('\n').find(l => l.includes('Driver version')) || info.split('\n')[0];
    log.info('VAAPI', `vainfo 驱动信息: ${(driverLine || '').trim()}`);
  } catch (e) {
    log.warn('VAAPI', `vainfo 诊断执行失败（不影响后续判断）: ${e.message.split('\n')[0]}`);
  }

  const t0 = Date.now();
  try {
    await runFFmpeg([
      '-loglevel', 'error',
      '-init_hw_device', `vaapi=va:${VAAPI_DEVICE}`,
      '-filter_hw_device', 'va',
      '-f', 'lavfi', '-i', 'color=black:size=64x64:rate=1',
      '-frames:v', '1',
      '-vf', 'format=nv12,hwupload',
      '-c:v', 'h264_vaapi',
      '-f', 'null', '-',
    ]);
    log.info('VAAPI', `核显调用: 成功，自检耗时 ${Date.now() - t0}ms —— 后续转码将优先使用 h264_vaapi 硬件编解码`);
    vaapiState = true;
  } catch (e) {
    log.warn('VAAPI', `核显调用: 失败，自检未通过（耗时 ${Date.now() - t0}ms），原因: ${lastErrLine(e)} —— 回退到软件编码 (libx264)`);
    vaapiState = false;
  }
  return vaapiState;
}

// ---------- NVENC（NVIDIA 独显/核显）硬件加速探测 ----------
// 原理与 VAAPI 探测完全一致：宿主机把 NVIDIA 显卡直通进容器（通过
// nvidia-container-toolkit 提供的 nvidia runtime）之后，容器里能看到
// nvidia-smi、libnvidia-encode.so 等，但这些都只代表"驱动可见"，并不代表
// ffmpeg 真的能调用 h264_nvenc 编码器——同样需要一次最小成本的真实编码自检
// 才能确保后续歌曲都能直接复用一个可靠的判断结果。
//
// 注意：NVIDIA 显卡走的是完全独立于 VAAPI 的一套设备/驱动体系（/dev/nvidia0
// 等设备节点由 nvidia-container-toolkit 的运行时钩子自动挂载，不是
// /dev/dri），所以 VAAPI_DEVICE 这个环境变量对 NVIDIA 卡完全不起作用，
// 二者是两套独立的探测与编码路径，互不影响、可以共存（多显卡/混合部署时
// 优先用 NVENC，NVENC 不可用再退到 VAAPI，最后才是纯软件编码）。
let nvencState = null;

async function detectNVENC() {
  if (nvencState !== null) return nvencState;

  log.info('NVENC', '开始探测 NVIDIA 显卡硬件加速（h264_nvenc）...');

  // NVENC 专用的 ffmpeg-nvenc 二进制只在 amd64 镜像里安装（见 Dockerfile 里
  // 的架构判断），arm64 上这个文件不存在是正常情况，不代表哪里出了故障。
  if (!fs.existsSync('/usr/local/bin/ffmpeg-nvenc')) {
    log.warn('NVENC', 'NVENC 专用的 ffmpeg-nvenc 二进制不存在（预期情况：镜像只在 amd64 架构上安装这份二进制，NVIDIA 显卡目前也基本只出现在 x86_64 平台）—— NVIDIA 硬件加速: 失败');
    nvencState = false;
    return false;
  }

  // 顺带把 nvidia-smi 摘要打进日志，出问题时（比如宿主机没装
  // nvidia-container-toolkit / 没注册 nvidia runtime / 驱动版本不对）一眼
  // 就能看出来。nvidia-smi 本身由 nvidia-container-toolkit 在容器启动时
  // 自动挂载进来，镜像里不需要也不应该自己安装它。
  try {
    const info = execFileSync('nvidia-smi', { timeout: 8000 }).toString();
    const line = info.split('\n').find(l => l.includes('Driver Version')) || info.split('\n')[0];
    log.info('NVENC', `nvidia-smi 驱动信息: ${(line || '').trim()}`);
  } catch (e) {
    log.warn('NVENC', `nvidia-smi 不可用（容器内看不到 NVIDIA 显卡：宿主机可能没装 nvidia-container-toolkit、没在 /etc/docker/daemon.json 注册 nvidia runtime，或者安装/升级时 NVIDIA 相关段落被自动裁掉）—— NVIDIA 硬件加速: 失败`);
    nvencState = false;
    return false;
  }

  const t0 = Date.now();
  try {
    await runFFmpeg([
      '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=black:size=64x64:rate=1',
      '-frames:v', '1',
      '-c:v', 'h264_nvenc',
      '-f', 'null', '-',
    ], 'ffmpeg-nvenc');
    log.info('NVENC', `NVIDIA 显卡调用: 成功，自检耗时 ${Date.now() - t0}ms —— 后续转码将优先使用 h264_nvenc 硬件编解码`);
    nvencState = true;
  } catch (e) {
    log.warn('NVENC', `NVIDIA 显卡调用: 失败，自检未通过（耗时 ${Date.now() - t0}ms），原因: ${lastErrLine(e)} —— 回退到 VAAPI（如可用）或 libx264`);
    nvencState = false;
  }
  return nvencState;
}

// 同一首歌同一时间只允许一个生成任务在跑，避免并发请求把 ffmpeg 打架
const building = new Map();   // song_id -> Promise（整首歌全部轨道转码完成）
const buildErrors = new Map(); // song_id -> Error（最近一次转码失败原因）

// 供「曲库管理 - 清理缓存」(cacheCleaner.js) 判断/清理某首歌当前的转码状态，
// 不需要它自己再维护一份重复的 building/buildErrors。
function isBuilding(id) {
  return building.has(id) || building.has(Number(id)) || building.has(String(id));
}
function forgetBuildState(id) {
  building.delete(id); building.delete(Number(id)); building.delete(String(id));
  buildErrors.delete(id); buildErrors.delete(Number(id)); buildErrors.delete(String(id));
}

// 「按存储空间限额清理缓存」需要在每次新缓存生成完成后就有机会立刻检查一次
// 总量是否超限（而不是干等每日一次的定时清理），这里提供一个轻量的订阅点：
// 谁关心"转码又完成了一首"，就注册一个回调，buildHLS 全部轨道转码成功后会
// 依次通知。回调本身出错不影响转码流程本身。
const buildCompleteListeners = [];
function onBuildComplete(fn) {
  if (typeof fn === 'function') buildCompleteListeners.push(fn);
}
function notifyBuildComplete(songId) {
  for (const fn of buildCompleteListeners) {
    try { fn(songId); } catch (e) { log.warn('TRANSCODE', `构建完成回调执行失败(id=${songId}): ${e.message}`); }
  }
}

function outDir(id) {
  return path.join(HLS_DIR, String(id));
}
function masterPath(id) {
  return path.join(outDir(id), 'master.m3u8');
}
function completeMarkerPath(id) {
  return path.join(outDir(id), '.complete');
}

// "新鲜"指的是这首歌之前已经完整转码成功过，且源文件之后没有被替换过，
// 可以直接复用，不需要重新转码。用一个 .complete 标记文件的 mtime 来判断，
// 而不是 master.m3u8 —— 因为现在 master.m3u8 在转码刚开始时就会写出来，
// 它的存在不再代表"转码已完成"。
function isFresh(id, srcPath) {
  const marker = completeMarkerPath(id);
  if (!fs.existsSync(marker)) return false;
  try {
    const srcStat = fs.statSync(srcPath);
    const outStat = fs.statSync(marker);
    // 源文件比已生成的 HLS 还新（比如换了同名文件），要求重新生成
    return outStat.mtimeMs >= srcStat.mtimeMs;
  } catch (e) {
    return false;
  }
}

// 判断源编码是否可以直接 -c copy 进 MPEG-TS 且能被浏览器/hls.js 解码。
// 注意：不能只靠 ffmpeg 的退出码判断"copy 是否安全"——实测对 VP8/Opus 这类
// 编码执行 -c copy 进 TS，ffmpeg 退出码是 0（不报错），但产出的是无法解码的
// 垃圾流(ffprobe 显示 codec_name=bin_data)，播放器只会一直黑屏/无声，且此时
// 完全没有异常可捕获来触发回退。所以必须提前用 ffprobe 探测编码，只有明确
// 在白名单里的编码才走 copy，其余一律直接转码，保证任何源格式最终都能出片。
const SAFE_VIDEO_CODECS = new Set(['h264']);
const SAFE_AUDIO_CODECS = new Set(['aac']);

// Bug修复（同一首歌在不同主机表现不一致的根源之一）：这里以前失败时是纯粹
// `catch(e){return '';}`——不管是 ffprobe 根本没装/PATH 找不到、文件在慢速
// NAS/网络共享上读取超时、还是这台机器本身负载太高导致连"起一个 ffprobe
// 子进程"都要排队超过 15s，日志里看到的都只是统一的"源编码=未知"，完全没法
//区分"这台机器就是探测失败了"还是"这台机器只是比另一台慢"。现在把真实的
// 失败原因打进日志（songTag 为空时说明是扫描阶段调用，不打歌曲前缀）；同时
// 把超时从 15s 放宽到 30s——观察到的现象是负载高的机器上，转码这类正常操作
// 都可能耗时几十秒，15s 对探测这一步来说太容易被"机器繁忙"误判成"探测失败"。
function probeCodecName(filepath, selector, songTag) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error',
      '-select_streams', selector,
      '-show_entries', 'stream=codec_name',
      '-of', 'csv=p=0',
      filepath,
    ], { timeout: 30000 }).toString().trim();
    return out.split('\n')[0].trim().toLowerCase();
  } catch (e) {
    log.error('TRANSCODE', `${songTag ? songTag + ' ' : ''}探测源编码失败(${selector})，按"未知编码"处理，走转码兜底: ${lastErrLine(e)}`);
    return ''; // 探测失败时按"未知编码"处理，走转码这条更保险的路径
  }
}

// 从 Error 对象里提取"值得写进日志"的那一段原因描述。
//
// 之前各处日志统一用的是 `lastErrLine(e)`——只取按换行拆分后的
// 最后一段。这在 ffmpeg 报错信息本身干净利落、且不以换行符结尾时没问题；
// 但实测发现 ffmpeg/vainfo 的 stderr 经常以一个尾随换行符结束，这时候
// split('\n') 出来的最后一个元素是空字符串——日志里"原因: "后面直接就是
// 空的，看起来像是"报错了但没有原因"，实际上真正有用的报错内容是倒数第二
// 行，被这个写法整个吞掉了。VAAPI 那次"核显调用: 失败...原因: "后面一片空白
// 就是这个 bug 的直接体现。
// 改成：按换行拆分后先过滤掉空行/纯空白行，再取最后几行（默认3行）拼起来，
// 这样即使 stderr 末尾有空行，也不会丢失真正有诊断价值的内容；多取几行还能
// 覆盖"报错信息分布在最后两三行"的情况（比如 ffmpeg 常见的
// "Unknown encoder ..." 和紧随其后的一行汇总信息）。
function lastErrLine(err, maxLines = 3) {
  const msg = (err && err.message) ? String(err.message) : String(err);
  const lines = msg.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return '(ffmpeg 未输出任何 stderr 内容，可能是启动阶段就失败，比如命令本身不存在或参数非法)';
  return lines.slice(-maxLines).join(' | ');
}

// bin 参数：默认用系统 ffmpeg（apt 装的，跟 va-driver-all 的驱动 ABI 一致，
// VAAPI/libx264 路径全部走这个默认值，不受影响）。NVENC 专用路径会显式传入
// 'ffmpeg-nvenc'（BtbN 静态编译版，见 Dockerfile 里的说明:两份二进制分开用，
// 避免 BtbN 内置的 libva 和系统驱动 ABI 不一致导致 VAAPI 失效的问题）。
function runFFmpeg(args, bin = 'ffmpeg') {
  return new Promise((resolve, reject) => {
    const ff = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errBuf = '';
    ff.stderr.on('data', d => {
      errBuf += d.toString();
      if (errBuf.length > 4000) errBuf = errBuf.slice(-4000);
    });
    ff.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${bin} exit ${code}: ${errBuf}`));
    });
    ff.on('error', reject);
  });
}

// hls_playlist_type 用 "event" 而不是 "vod"：
// "vod" 类型下 ffmpeg 会把整份播放列表攒在内存里，直到整个输入转码完毕才
// 一次性写出 .m3u8 文件——也就是说子播放列表文件在转码 100% 完成之前根本
// 不存在，播放器（hls.js）自然拿不到任何东西，这正是"卡住"的根源之一。
// "event" 类型会随着每一个分片产出持续增量刷新 .m3u8 文件，播放器可以在
// 转码只完成一小部分时就开始拉取已经就绪的分片播放，等追上转码进度后
// 继续边转边播；ffmpeg 在整个输入转码结束时会照常在文件末尾写入
// #EXT-X-ENDLIST，播放器据此知道后面不会再有新分片了。
function hlsOutArgs(segPattern, playlistPath) {
  return [
    '-f', 'hls',
    '-hls_time', String(SEGMENT_TIME),
    '-hls_playlist_type', 'event',
    '-hls_flags', 'independent_segments+temp_file',
    '-hls_segment_filename', segPattern,
    playlistPath,
  ];
}

// 视频轨：只有源编码是 h264 时才 -c copy 直拷贝（零转码，几乎无延迟）。
// 其余编码需要重新编码为 H.264 时，优先尝试 VAAPI 硬件转码：
//   Tier 1：解码 + 编码整条链路都走硬件（-hwaccel vaapi），效率最高，
//           但要求源视频编码本身能被 VAAPI 硬件解码器支持；
//   Tier 2：源编码硬件解不了时，退一步用软件解码、只在编码这一步用
//           h264_vaapi 硬件编码（hwupload 把软解出来的帧送上 GPU），
//           兼容性更好，依然能吃到硬件编码的加速；
//   Tier 3：以上都不行（没有 VAAPI/驱动异常/这台机器压根没有核显独显）
//           时，回退到纯软件的 libx264，保证任何机器最终都能出片。
async function buildVideoRendition(filepath, dir, songTag) {
  const common = ['-loglevel', 'error', '-y', '-i', filepath, '-map', '0:v:0', '-an'];
  const out = hlsOutArgs(path.join(dir, 'video_%04d.ts'), path.join(dir, 'video.m3u8'));
  const codec = probeCodecName(filepath, 'v:0', songTag);
  const t0 = Date.now();

  log.info('TRANSCODE', `${songTag} 视频轨: 源编码=${codec || '未知'}`);

  if (SAFE_VIDEO_CODECS.has(codec)) {
    try {
      await runFFmpeg([...common, '-c:v', 'copy', ...out]);
      log.info('TRANSCODE', `${songTag} 视频轨: 直接封装拷贝(copy)完成，耗时 ${Date.now() - t0}ms，未使用核显`);
      return;
    } catch (e) {
      log.warn('TRANSCODE', `${songTag} 视频轨: h264 -c copy 仍失败，改为重新编码: ${lastErrLine(e)}`);
    }
  }

  const useNvenc = await detectNVENC();
  if (useNvenc) {
    // Tier 0：NVIDIA 硬解(cuda) + 硬编(h264_nvenc)，两张显卡都可用时优先级
    // 最高——消费级 NVIDIA 显卡的 NVENC 编码效率通常明显好于核显 VAAPI。
    const t0b = Date.now();
    try {
      await runFFmpeg([
        '-loglevel', 'error', '-y',
        '-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda',
        '-i', filepath, '-map', '0:v:0', '-an',
        '-c:v', 'h264_nvenc',
        ...out,
      ], 'ffmpeg-nvenc');
      log.info('TRANSCODE', `${songTag} 视频轨: NVIDIA 显卡调用成功(Tier0 硬解+硬编 h264_nvenc)，耗时 ${Date.now() - t0b}ms`);
      return;
    } catch (e) {
      log.warn('TRANSCODE', `${songTag} 视频轨: NVIDIA 硬解+硬编失败(Tier0)，尝试软解+NVENC硬编: ${lastErrLine(e)}`);
    }

    // Tier 0b：软件解码 + NVENC 硬件编码（兼容 CUDA 解不了的源编码，仍能
    // 吃到 NVENC 编码加速）。
    const t0c = Date.now();
    try {
      await runFFmpeg([...common, '-c:v', 'h264_nvenc', ...out], 'ffmpeg-nvenc');
      log.info('TRANSCODE', `${songTag} 视频轨: NVIDIA 显卡调用成功(Tier0b 软解+硬编 h264_nvenc)，耗时 ${Date.now() - t0c}ms`);
      return;
    } catch (e) {
      log.warn('TRANSCODE', `${songTag} 视频轨: NVENC 全部尝试失败，改试 VAAPI(如可用)/libx264: ${lastErrLine(e)}`);
    }
  }

  const useVaapi = await detectVAAPI();
  if (useVaapi) {
    // Tier 1：硬件解码 + 硬件编码
    const t1 = Date.now();
    try {
      await runFFmpeg([
        '-loglevel', 'error', '-y',
        '-hwaccel', 'vaapi', '-hwaccel_device', VAAPI_DEVICE, '-hwaccel_output_format', 'vaapi',
        '-i', filepath, '-map', '0:v:0', '-an',
        '-c:v', 'h264_vaapi',
        ...out,
      ]);
      log.info('TRANSCODE', `${songTag} 视频轨: 核显调用成功(Tier1 硬解+硬编 h264_vaapi)，耗时 ${Date.now() - t1}ms`);
      return;
    } catch (e) {
      log.warn('TRANSCODE', `${songTag} 视频轨: 核显硬解+硬编失败(Tier1)，尝试软解+硬编(Tier2): ${lastErrLine(e)}`);
    }

    // Tier 2：软件解码 + 硬件编码（兼容硬件解不了的源编码，仍用硬件编码加速）
    const t2 = Date.now();
    try {
      await runFFmpeg([
        ...common,
        '-vaapi_device', VAAPI_DEVICE,
        '-vf', 'format=nv12,hwupload',
        '-c:v', 'h264_vaapi',
        ...out,
      ]);
      log.info('TRANSCODE', `${songTag} 视频轨: 核显调用成功(Tier2 软解+硬编 h264_vaapi)，耗时 ${Date.now() - t2}ms`);
      return;
    } catch (e) {
      log.warn('TRANSCODE', `${songTag} 视频轨: 核显调用失败(Tier2 软解+硬编)，回退到纯软件编码(Tier3 libx264): ${lastErrLine(e)}`);
    }
  } else {
    log.info('TRANSCODE', `${songTag} 视频轨: NVENC/VAAPI 均不可用，直接使用软件编码(Tier3 libx264)`);
  }

  // Tier 3：纯软件编码兜底
  const t3 = Date.now();
  await runFFmpeg([...common, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', ...out]);
  log.info('TRANSCODE', `${songTag} 视频轨: 软件编码(Tier3 libx264)完成，耗时 ${Date.now() - t3}ms，未使用核显`);
}

// 计算一首歌曲应该转多长(秒)。CUE 分轨=结束-起点(最后一首用整轨时长-起点)；
// 普通歌曲用数据库 duration；都没有时现场 ffprobe；最终给 600s 安全上限，避免
// 探不到时长时动态背景源无限转码、空耗 CPU。
function resolveDurationSec(song, filepath) {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  if (song.media_type === 'cue') {
    const start = num(song.start_offset) || 0;
    const end = num(song.end_offset);
    if (end && end > start) return end - start;
    const whole = probeFormatDuration(filepath);
    if (whole && whole > start) return whole - start;
  }
  const d = num(song.duration);
  if (d && d > 0) return d;
  const probed = probeFormatDuration(filepath);
  return probed && probed > 0 ? probed : 600;
}

function probeFormatDuration(filepath) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filepath], { timeout: 30000 }).toString().trim();
    const v = parseFloat(out.split('\n')[0]);
    return Number.isFinite(v) ? v : null;
  } catch (e) { return null; }
}

// 纯音频背景视频轨：产出与 buildVideoRendition 同名的 video.m3u8，从而让纯音频
// 歌也走"视频轨 + 音频轨"的标准 master 结构，tvOS/网页无需为纯音频单独适配。
// 优先随机铺用户背景视频并循环；没有就用 ffmpeg 流动渐变；再不行静态深色兜底。
async function buildAudioBackgroundRendition(song, dir, durSec, songTag) {
  const out = hlsOutArgs(path.join(dir, 'video_%04d.ts'), path.join(dir, 'video.m3u8'));
  const dur = Number.isFinite(durSec) && durSec > 0 ? String(Math.round(durSec * 10) / 10) : null;
  const t0 = Date.now();
  const W = 1920, H = 1080, FPS = 30;
  // 实测瓶颈在 gradients 滤镜逐像素生成速度(1080p 仅约1x实时、480p 约4.4x、静态约8x)，
  // 与编码器无关。渐变是柔和色块，低分辨率生成再放大几乎无观感损失，因此内置源用
  // 480p 生成、在滤镜链里 scale 上变换到输出分辨率，把生成速度提上来。
  const GW = 854, GH = 480;
  const bg = pickBackgroundVideo();
  // 背景源优先级：用户背景视频(循环) > 内置流动渐变 > 静态深色，逐级回退
  const sources = [];
  if (bg) sources.push({ kind: 'bg视频:' + path.basename(bg), input: ['-stream_loop', '-1', '-i', bg], fit: true });
  sources.push({ kind: '流动渐变', input: ['-f', 'lavfi', '-i', `gradients=size=${GW}x${GH}:rate=${FPS}:c0=0x141428:c1=0x33265c:speed=0.02`], fit: false });
  sources.push({ kind: '静态深色', input: ['-f', 'lavfi', '-i', `color=c=0x141428:size=${GW}x${GH}:rate=${FPS}`], fit: false });

  const useVaapi = await detectVAAPI();
  let lastErr = null;
  for (const s of sources) {
    // 方案一：VAAPI 硬件编码（NAS 核显）。用户视频走缩放补边；内置低分辨率源上变换到 1080p
    if (useVaapi) {
      try {
        const vf = s.fit
          ? `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,fps=${FPS},format=nv12,hwupload`
          : `scale=${W}:${H}:flags=fast_bilinear,format=nv12,hwupload`;
        const args = ['-loglevel', 'error', '-y', '-vaapi_device', VAAPI_DEVICE, ...s.input];
        if (dur) args.push('-t', dur);
        args.push('-an', '-vf', vf, '-c:v', 'h264_vaapi', '-g', '120', ...out);
        await runFFmpeg(args);
        log.info('TRANSCODE', `${songTag} 纯音频背景轨(${s.kind},VAAPI硬编1080p)完成，耗时 ${Date.now() - t0}ms`);
        return;
      } catch (e) { lastErr = e; log.warn('TRANSCODE', `${songTag} 背景轨 VAAPI 失败(${s.kind})，回退软编: ${lastErrLine(e)}`); }
    }
    // 方案二：libx264 软件编码，内置源 480p 生成上变换到 720p（实测约4x实时），用户视频补边到 720p
    try {
      const SW = 1280, SH = 720;
      const vf = s.fit
        ? `scale=${SW}:${SH}:force_original_aspect_ratio=decrease,pad=${SW}:${SH}:(ow-iw)/2:(oh-ih)/2:black,fps=25,format=yuv420p`
        : `scale=${SW}:${SH}:flags=fast_bilinear,format=yuv420p`;
      const args = ['-loglevel', 'error', '-y', ...s.input];
      if (dur) args.push('-t', dur);
      args.push('-an', '-vf', vf, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-g', '100', ...out);
      await runFFmpeg(args);
      log.info('TRANSCODE', `${songTag} 纯音频背景轨(${s.kind},软编720p)完成，耗时 ${Date.now() - t0}ms`);
      return;
    } catch (e) { lastErr = e; log.warn('TRANSCODE', `${songTag} 背景轨软编也失败(${s.kind})，尝试下一背景源: ${lastErrLine(e)}`); }
  }
  throw lastErr || new Error('纯音频背景轨所有方案均失败');
}

// 探测单音轨源文件的声道数：用于区分"真正的单声道(mono)"(没法做原/伴唱
// 分离，只能出1条音轨)和"单音轨但源是立体声"(老式声道型 MV，左右声道分别
// 是伴唱/原唱，能用 pan 滤镜虚拟出2条音轨)。只在 audio_tracks<2 时才需要
// 探测，真正多音轨的歌不会调用这个函数。探测失败(ffprobe 挂了/文件读取
// 异常)时保守返回 0，按"没法判定声道数"处理，退回到普通单音轨(不做声道
// 分离)，不冒险生成语义可能错误的虚拟音轨。
function probeAudioChannels(filepath, songTag) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=channels',
      '-of', 'csv=p=0',
      filepath,
    ], { timeout: 30000 }).toString().trim();
    const n = parseInt(out.split('\n')[0], 10);
    return Number.isFinite(n) ? n : 0;
  } catch (e) {
    log.warn('TRANSCODE', `${songTag ? songTag + ' ' : ''}探测源音频声道数失败，按"无法声道分离"保守处理: ${lastErrLine(e)}`);
    return 0;
  }
}

// 音频轨：只有源编码是 aac 时才 -c copy，其余编码（Opus/Vorbis/FLAC/AC3 等）
// 直接重新编码为 AAC。音频转码本身 CPU 消耗很低，没有必要也没有硬件通道，
// 继续用软件编码即可。
async function buildAudioRendition(filepath, dir, track, songTag, seek) {
  // CUE 分轨：-i 之后做精确输出端 seek(-ss 起点、-t 时长)，输出时间戳从 0 开始，
  // 与从 0 开始的背景视频轨天然对齐；普通歌曲 seek 为空，命令与原来完全一致。
  const seekArgs = (seek && Number.isFinite(seek.ss)) ? ['-ss', String(seek.ss), ...(Number.isFinite(seek.t) ? ['-t', String(seek.t)] : [])] : [];
  const common = ['-loglevel', 'error', '-y', '-i', filepath, ...seekArgs, '-map', `0:a:${track}`, '-vn'];
  const out = hlsOutArgs(path.join(dir, `audio${track}_%04d.ts`), path.join(dir, `audio${track}.m3u8`));
  const codec = probeCodecName(filepath, `a:${track}`, songTag);
  const trackName = track === 0 ? '原唱' : track === 1 ? '伴唱' : `音轨${track}`;
  const t0 = Date.now();
  log.info('TRANSCODE', `${songTag} 音轨${track}(${trackName}): 源编码=${codec || '未知'}`);
  if (SAFE_AUDIO_CODECS.has(codec)) {
    try {
      await runFFmpeg([...common, '-c:a', 'copy', ...out]);
      log.info('TRANSCODE', `${songTag} 音轨${track}(${trackName}): 直接封装拷贝(copy)完成，耗时 ${Date.now() - t0}ms`);
      return;
    } catch (e) {
      log.warn('TRANSCODE', `${songTag} 音轨${track}(${trackName}): aac -c copy 仍失败，改为重新编码: ${lastErrLine(e)}`);
    }
  }
  const t1 = Date.now();
  await runFFmpeg([...common, '-c:a', 'aac', '-b:a', '192k', ...out]);
  log.info('TRANSCODE', `${songTag} 音轨${track}(${trackName}): 软件编码(aac)完成，耗时 ${Date.now() - t1}ms`);
}

// 需求（单音轨自动检测+预解码，供客户端软解切原/伴唱）：
// 源文件其实只有 0:a:0 这一条真实音频流(audio_tracks<2)，但如果这条流本身
// 是立体声(2声道)，很可能是老式"声道型"编码——左右声道分别对应伴唱/原唱
// (跟 TV 端 web/index.html 里 VoiceManager.applyStereo() 处理的是同一类文件，
// 那边是在浏览器端用 Web Audio 的 ChannelSplitter/Merger 做声道复制)。
// Android 客户端的 ExoPlayer 没有等价的"运行时声道级处理"能力，只能通过
// TrackSelectionOverride 在"多条独立音轨"之间切换，所以这里把声道复制这一步
// 挪到服务端用 ffmpeg 的 pan 滤镜完成，虚拟出两条独立的 HLS 音频渲染，语义
// 与网页端完全对齐：track 0(原唱)=右声道(c1)复制到左右两声道，
// track 1(伴唱)=左声道(c0)复制到左右两声道。产出的目录结构(audio0.m3u8/
// audio1.m3u8)跟"真正的多音轨"完全一样，index.js 路由层和客户端都不需要
// 关心背后是真实的多音轨还是这里合成出来的。
async function buildStereoSplitAudioRendition(filepath, dir, track, songTag, seek) {
  const seekArgs = (seek && Number.isFinite(seek.ss)) ? ['-ss', String(seek.ss), ...(Number.isFinite(seek.t) ? ['-t', String(seek.t)] : [])] : [];
  const common = ['-loglevel', 'error', '-y', '-i', filepath, ...seekArgs, '-map', '0:a:0', '-vn'];
  const panFilter = track === 0 ? 'pan=stereo|c0=c1|c1=c1' : 'pan=stereo|c0=c0|c1=c0';
  const out = hlsOutArgs(path.join(dir, `audio${track}_%04d.ts`), path.join(dir, `audio${track}.m3u8`));
  const trackName = track === 0 ? '原唱' : '伴唱';
  const t0 = Date.now();
  log.info('TRANSCODE', `${songTag} 音轨${track}(${trackName}·声道复制虚拟音轨): 源为单音轨立体声，用 pan 滤镜复制${track === 0 ? '右' : '左'}声道到双耳`);
  await runFFmpeg([...common, '-af', panFilter, '-c:a', 'aac', '-b:a', '192k', ...out]);
  log.info('TRANSCODE', `${songTag} 音轨${track}(${trackName}·声道复制虚拟音轨): 完成，耗时 ${Date.now() - t0}ms`);
}

// 立即写出 master.m3u8——它只依赖"这首歌有几条音轨"这个已经存在于数据库里
// 的信息，跟视频/音频具体转码进度无关，所以不需要等任何 ffmpeg 进程完成
// 就可以先生成并让播放器拿到。播放器随后请求 video.m3u8 / audioN.m3u8 时，
// 如果对应分片还没转出来，由路由层(index.js)负责短暂等待，而不是在这里
// 阻塞。
function writeMasterPlaylist(dir, trackCount, names) {
  const fallback = trackCount >= 3 ? ['原唱', '半消', '伴奏'] : trackCount >= 2 ? ['原唱', '伴唱'] : ['原唱'];
  const trackNames = names || fallback;
  let m3u8 = '#EXTM3U\n#EXT-X-VERSION:6\n';
  for (let t = 0; t < trackCount; t++) {
    const name = trackNames[t] || `音轨${t + 1}`;
    const isDefault = t === 0 ? 'YES' : 'NO';
    m3u8 += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="${name}",DEFAULT=${isDefault},AUTOSELECT=${isDefault},URI="audio${t}.m3u8"\n`;
  }
  m3u8 += '#EXT-X-STREAM-INF:BANDWIDTH=8000000,AUDIO="aud"\nvideo.m3u8\n';
  fs.writeFileSync(path.join(dir, 'master.m3u8'), m3u8);
}

// AI 人声分离产物可用判定：sep_status=done 且人声/伴奏两个 wav 都真实存在。
// songs 里存的是相对 /data 的路径(separated/<id>/vocals.wav)，这里拼回容器内绝对路径。
// 任一文件缺失(比如被清理/没传完整)都返回 null，调用方退回普通单/双轨逻辑，不会半吊子。
function resolveSeparated(song) {
  if (!song || song.sep_status !== 'done' || !song.vocal_path || !song.accomp_path) return null;
  const vocalAbs = path.join(DATA_DIR, song.vocal_path);
  const accompAbs = path.join(DATA_DIR, song.accomp_path);
  try {
    if (!fs.existsSync(vocalAbs) || !fs.existsSync(accompAbs)) return null;
  } catch (e) { return null; }
  return { vocalAbs, accompAbs };
}

// 半消人声比例：半消档把人声压到 32%（隐约可闻作引导），伴奏保持全量。
const HALF_VOCAL_VOLUME = '0.32';
// 基于 AI 分离产物生成某一条音频 rendition。
//   track=1 mode='half'  半消 = 伴奏(全量) + 人声(32%)
//   track=2 mode='accomp' 伴奏 = 纯 accompaniment.wav
// 原唱档(track0)直接用源文件走 buildAudioRendition，保证是未经任何损失的原始混音。
// amix 必须 normalize=0，否则它会按输入路数把总音量自动减半；Demucs 的人声/伴奏
// 本身等长且时间对齐，duration=longest 兜底长度，dropout_transition=0 避免尾部淡出。
async function buildSeparatedMixRendition(dir, track, sep, mode, songTag) {
  const out = hlsOutArgs(path.join(dir, `audio${track}_%04d.ts`), path.join(dir, `audio${track}.m3u8`));
  const label = mode === 'accomp' ? '伴奏' : '半消';
  const t0 = Date.now();
  let args;
  if (mode === 'accomp') {
    args = ['-loglevel', 'error', '-y', '-i', sep.accompAbs, '-map', '0:a:0', '-vn',
      '-c:a', 'aac', '-b:a', '192k', ...out];
  } else {
    args = ['-loglevel', 'error', '-y', '-i', sep.vocalAbs, '-i', sep.accompAbs,
      '-filter_complex',
      `[0:a]volume=${HALF_VOCAL_VOLUME}[v];[1:a][v]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[a]`,
      '-map', '[a]', '-c:a', 'aac', '-b:a', '192k', ...out];
  }
  await runFFmpeg(args);
  log.info('TRANSCODE', `${songTag} 音轨${track}(${label}·AI分离): 完成，耗时 ${Date.now() - t0}ms`);
}

// 视频轨 + 每条音频轨的 ffmpeg 进程并发启动（Promise.all），而不是像旧版
// 那样排队一条条等——这样多条轨道是同时在产出分片的，进一步缩短"能看到第
// 一屏画面"所需的时间。全部轨道都转码成功后才写 .complete 标记；任何一条
// 失败都会被上层捕获记录，方便前端/路由层判断这首歌为什么迟迟出不了片。
// effectiveTrackCount 由调用方(ensureHLS)算好传进来，避免这里重复探测一次
// 声道数(ensureHLS 为了同步写出 master.m3u8 已经探测过一次了)。
async function buildHLS(song, dir, effectiveTrackCount, filepath, durSec, separated) {
  const declaredTracks = Math.max(1, song.audio_tracks || 1);
  const songTag = `[歌曲 id=${song.id} "${song.title || song.filename}"]`;
  const t0 = Date.now();

  // 纯音频(mp3/flac/wav/ape)/CUE 分轨没有源视频轨：视频任务换成动态背景轨；
  // CUE 分轨还要给音频任务传截取区间(从整轨 start_offset 起、时长 durSec)。
  const isAudioOnly = song.media_type === 'audio' || song.media_type === 'cue';
  const seek = (isAudioOnly && song.media_type === 'cue' && Number.isFinite(Number(song.start_offset)))
    ? { ss: Number(song.start_offset) || 0, t: durSec } : null;
  const videoTask = isAudioOnly
    ? buildAudioBackgroundRendition(song, dir, durSec, songTag)
    : buildVideoRendition(filepath, dir, songTag);
  const tasks = [videoTask];
  if (separated) {
    // AI 人声分离已完成：出 原唱(源混音)/半消(人声32%+伴奏)/纯伴奏 三档，
    // 复用现有 HLS 多音轨切换，tvOS/网页无需改音轨选择逻辑即可三档互斥切换。
    log.info('TRANSCODE', `${songTag} 开始转码，AI分离三档：0=原唱(源) 1=半消 2=伴奏`);
    tasks.push(buildAudioRendition(filepath, dir, 0, songTag, seek));
    tasks.push(buildSeparatedMixRendition(dir, 1, separated, 'half', songTag));
    tasks.push(buildSeparatedMixRendition(dir, 2, separated, 'accomp', songTag));
  } else if (declaredTracks >= 2) {
    log.info('TRANSCODE', `${songTag} 开始转码，共 ${declaredTracks} 条真实音轨（1=原唱, 2=伴唱）`);
    for (let t = 0; t < declaredTracks; t++) {
      tasks.push(buildAudioRendition(filepath, dir, t, songTag, seek));
    }
  } else if (effectiveTrackCount >= 2 && !isAudioOnly) {
    log.info('TRANSCODE', `${songTag} 单音轨但源为立体声，按"声道型"虚拟出2条音轨(声道复制：0=原唱=右声道，1=伴唱=左声道)，供软解(HLS)模式下原/伴唱切换`);
    tasks.push(buildStereoSplitAudioRendition(filepath, dir, 0, songTag, seek));
    tasks.push(buildStereoSplitAudioRendition(filepath, dir, 1, songTag, seek));
  } else {
    log.info('TRANSCODE', `${songTag} 开始转码，共 1 条音轨（单声道，无法声道分离）`);
    tasks.push(buildAudioRendition(filepath, dir, 0, songTag, seek));
  }
  try {
    await Promise.all(tasks);
  } catch (e) {
    log.error('TRANSCODE', `${songTag} 转码失败，总耗时 ${Date.now() - t0}ms，原因: ${lastErrLine(e)}`);
    throw e;
  }

  fs.writeFileSync(completeMarkerPath(song.id), String(Date.now()));
  log.info('TRANSCODE', `${songTag} 全部轨道转码完成，总耗时 ${Date.now() - t0}ms`);
  notifyBuildComplete(song.id);
}

async function ensureHLS(song) {
  const { id } = song;
  const songTag = `[歌曲 id=${id} "${song.title || song.filename}"]`;
  // 需求(网盘先缓存到本地再探测/播放)：网络挂载曲库的歌，转码源文件优先用
  // 本地缓存副本(如果已经缓存好)，没缓存好就暂时用网络路径兜底(同时后台
  // 已经在悄悄补缓存了，见 sourceCache.resolvePlaybackPath())，本地曲库的歌
  // 完全不受影响、还是原来的 filepath。
  let { path: filepath } = sourceCache.resolvePlaybackPath(song);

  // 需求(网盘STRM支持)：STRM 曲目没有"网络路径兜底"可用(filepath 只是一个
  // 本地 .strm 文本指针文件，不是可以直接丢给 ffmpeg 的媒体文件)，
  // resolvePlaybackPath() 在这种情况下会返回 path: null，同时已经在后台
  // 触发了一次 ensureCached()。ensureHLS() 本来就是"这首歌现在要播放，等它
  // 转码好"的场景(调用方要么是后台预热、要么是真正的 /hls 请求)，这里选择
  // 直接 await 一次 ensureCached() 等缓存落地，而不是像硬解直传(/stream)那样
  // 直接 404——转码本来就要等，等的时候顺便把源文件缓存这一步也一起等掉，
  // 用户感知上只是"转码稍微多花了下载这首歌的时间"，不会多一次失败。
  if (!filepath) {
    filepath = await sourceCache.ensureCached(song.id, sourceCache.resolveSourceInput(song.filepath));
  }

  if (isFresh(id, filepath)) {
    log.info('TRANSCODE', `${songTag} 命中已转码缓存，直接复用，不重新转码`);
    return masterPath(id);
  }

  if (building.has(id)) {
    log.info('TRANSCODE', `${songTag} 已有转码任务在后台进行中，本次请求直接复用该任务`);
  }

  if (!building.has(id)) {
    // 之前没有在跑的任务：清空旧目录（可能是上一次失败/源文件已替换留下的
    // 半成品），立刻写出 master.m3u8，然后把真正耗时的转码丢到后台异步跑，
    // 不在这里 await —— 这正是"渐进式"的关键：函数在转码真正开始产出任何
    // 一个分片之前就已经可以返回了。
    const dir = outDir(id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const declaredTracks = Math.max(1, song.audio_tracks || 1);
    // 单音轨时探测一次源音频声道数，决定 master.m3u8 到底要声明1条还是2条
    // (声道型虚拟)音轨。这次探测是一次很轻量的 ffprobe 元数据查询(不是
    // 转码本身)，放在这里同步做一次不会拖慢"渐进式"设计追求的"立刻返回
    // master.m3u8"目标；结果顺带传给 buildHLS()，避免重复探测。
    // 纯音频(普通 mp3/flac)虽然几乎都是立体声，但那是正常混音(左右合起来才完整)，
    // 不是老式声道型 MV 的"左伴唱/右原唱"，绝不能套用声道复制虚拟双轨(否则每边
    // 只剩一半混音、声音残缺)。纯音频强制 1 条完整音轨；只有 AI 分离产物
    // (declaredTracks>=2)才出真正的多轨。视频 MV 保留原有声道虚拟探测。
    const isAudioSong = song.media_type === 'audio' || song.media_type === 'cue';
    // AI 分离产物齐全则出三档(原唱/半消/伴奏)；否则按原有逻辑决定 1 条还是声道虚拟 2 条
    const separated = isAudioSong ? resolveSeparated(song) : null;
    let effectiveTrackCount, trackNames = null;
    if (separated) {
      effectiveTrackCount = 3;
      trackNames = ['原唱', '半消', '伴奏'];
    } else if (declaredTracks >= 2) effectiveTrackCount = declaredTracks;
    else if (isAudioSong) effectiveTrackCount = 1;
    else effectiveTrackCount = probeAudioChannels(filepath, songTag) >= 2 ? 2 : 1;
    writeMasterPlaylist(dir, effectiveTrackCount, trackNames);
    buildErrors.delete(id);
    // 纯音频/CUE：算出本次应转时长，供动态背景轨定长、CUE 截取区间使用
    const durSec = isAudioSong ? resolveDurationSec(song, filepath) : null;

    const p = buildHLS(song, dir, effectiveTrackCount, filepath, durSec, separated)
      .catch(e => { buildErrors.set(id, e); throw e; })
      .finally(() => building.delete(id));
    building.set(id, p);
    // Bug修复("容器无限重启"：网盘/网络挂载路径下源文件偶发访问不到导致
    // 转码失败，进而整个容器崩溃重启死循环)：
    // 上面这条链最终还是一个 rejected 的 Promise，但它只是被存进
    // building 这个 Map 待查(isBuilding()/清理逻辑用)，从来没有人真正
    // await 或 .catch() 过它本身——错误信息走的是 buildErrors 这条单独的
    // 路(waitForFile() 轮询消费)。这意味着 p 是一个彻头彻尾的"未处理
    // rejected promise"：Node 20 默认策略是遇到 unhandledRejection 直接
    // 终止整个进程；容器 restart:unless-stopped 又会把它拉起来，队列里
    // 那首失败的歌还在，预热转码再次触发、再次失败、再次崩溃——无限重启
    // 循环。这里补一个空 catch，只是让 p 这个 Promise"被处理过"，错误
    // 本身依然会通过 buildErrors 记录、被上面的 .catch(e=>{...}) 正常
    // 日志输出，不会被吞掉，只是不再让它以"未处理 rejection"的身份去
    // 撞 Node 的默认终止进程行为。
    p.catch(() => {});
    // 不 await —— 让转码在后台继续跑，函数立刻返回
  }

  return masterPath(id);
}

// 等待某个具体文件（子播放列表或分片）出现，供路由层在文件"还在转码中、
// 暂时不存在"时短暂轮询，而不是立刻 404 或者反过来等整首歌转完。
// 一旦文件出现就立刻 resolve，做到"随出随响应"。
function waitForFile(filepath, songId, { timeoutMs = 60000, intervalMs = 200 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    (function poll() {
      if (fs.existsSync(filepath)) return resolve(filepath);
      if (buildErrors.has(songId)) {
        return reject(Object.assign(new Error('转码失败'), { cause: buildErrors.get(songId), code: 'BUILD_FAILED' }));
      }
      if (Date.now() > deadline) {
        return reject(Object.assign(new Error('等待分片生成超时'), { code: 'TIMEOUT' }));
      }
      setTimeout(poll, intervalMs);
    })();
  });
}

function removeHLS(id) {
  fs.rmSync(outDir(id), { recursive: true, force: true });
  building.delete(id);
  buildErrors.delete(id);
  log.info('TRANSCODE', `[歌曲 id=${id}] 已清理 HLS 转码产物`);
}

// ---------- HLS 缓存每日清理 ----------
// HLS 转码产物（.ts 分片）只是一份可以随时重新生成的播放缓存，不是原始曲库
// 数据，但每首歌一旦转码过就会一直占着磁盘空间，曲库越大、播放过的歌越多，
// /data/hls 越滚越大，长期不清理会把 NAS 的存储空间越吃越紧。
// 之前唯一会清理这个目录的时机是 scanner.js 扫描时发现某首歌"源文件已不存在"
// 才触发的 removeHLS——也就是说只要源文件还在，哪怕这首歌几个月都没人点过，
// 它的 HLS 缓存也永远不会被回收。这里补一个独立于扫描的每日定时清理：
//   1) 孤儿目录：目录名（歌曲 id）在数据库里已经找不到对应记录——理论上
//      scanner.js 的清理逻辑会覆盖这种情况，但进程重启/异常退出等边界场景
//      可能让某次清理被跳过，这里作为兜底再兜一层。
//   2) 过期缓存：距离上一次转码完成（.complete 标记的 mtime）已经超过
//      HLS_CACHE_MAX_AGE_DAYS（默认 3 天）——这类歌曲源文件仍然存在、随时
//      可以点唱，只是最近点唱页面点这首歌就会照常触发 ensureHLS 重新生成，
//      对用户体验没有影响，只是把"不常被点的歌"占用的磁盘空间定期释放掉。
//      正在后台转码中的目录（building 里还有它，或者 .complete 还不存在）
//      一律跳过，避免清理逻辑跟正在写入的转码进程打架。
const HLS_CACHE_MAX_AGE_DAYS = Number(process.env.HLS_CACHE_MAX_AGE_DAYS) || 3;

function cleanupExpiredHLS(getValidSongIds) {
  if (!fs.existsSync(HLS_DIR)) return { scanned: 0, removed: 0 };

  let entries;
  try {
    entries = fs.readdirSync(HLS_DIR, { withFileTypes: true });
  } catch (e) {
    log.error('HLS_CLEAN', `读取 HLS 缓存目录失败，本次清理已跳过: ${e.message}`);
    return { scanned: 0, removed: 0 };
  }

  let validIds = null;
  try {
    validIds = getValidSongIds ? new Set(getValidSongIds()) : null;
  } catch (e) {
    log.warn('HLS_CLEAN', `获取有效曲目 id 列表失败，本次跳过孤儿目录清理，仅按过期时间清理: ${e.message}`);
  }

  const maxAgeMs = HLS_CACHE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let scanned = 0, removed = 0;

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue; // 只处理"数字目录名=歌曲id"这种规范产物，其它一律不动
    scanned++;
    const id = entry.name;

    if (building.has(id) || building.has(Number(id))) continue; // 正在转码中，跳过

    let reason = null;
    if (validIds && !validIds.has(Number(id)) && !validIds.has(id)) {
      reason = '对应歌曲已不在曲库中(孤儿缓存)';
    } else {
      const marker = completeMarkerPath(id);
      try {
        const st = fs.statSync(marker);
        if (now - st.mtimeMs > maxAgeMs) {
          reason = `距上次转码完成已超过 ${HLS_CACHE_MAX_AGE_DAYS} 天`;
        }
      } catch (e) {
        // .complete 不存在：要么转码还没完成过（不该在这里清），要么是一次
        // 半成品残留（上次转码中途异常退出），后者本身也该被清掉。用目录本身
        // 的 mtime 兜底判断是否"陈旧"，避免半成品目录永远留在磁盘上。
        try {
          const dirStat = fs.statSync(outDir(id));
          if (now - dirStat.mtimeMs > maxAgeMs) {
            reason = '半成品缓存目录长期未完成转码，判定为陈旧残留';
          }
        } catch (e2) { /* 目录本身都读不到，忽略，等下一轮再看 */ }
      }
    }

    if (reason) {
      try {
        fs.rmSync(outDir(id), { recursive: true, force: true });
        building.delete(id);
        buildErrors.delete(id);
        removed++;
        log.info('HLS_CLEAN', `[歌曲 id=${id}] 缓存已清理，原因: ${reason}`);
      } catch (e) {
        log.error('HLS_CLEAN', `[歌曲 id=${id}] 缓存清理失败: ${e.message}`);
      }
    }
  }

  log.info('HLS_CLEAN', `本次清理完成：共检查 ${scanned} 个缓存目录，清理 ${removed} 个`);
  return { scanned, removed };
}

// 每日定时任务：容器可能一次运行好几天甚至更久不重启，只在启动时清理一次
// 不够，这里用 setInterval 每 24 小时自动跑一次；应用刚启动时也顺带跑一次
// （延迟 5 分钟，避开启动初期的曲库全量扫描高峰，避免两个都要读写磁盘的
// 后台任务互相抢 IO）。定时器用 unref()，避免它阻止 Node 进程正常退出。
function scheduleHLSCleanup(getValidSongIds) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  setTimeout(() => cleanupExpiredHLS(getValidSongIds), 5 * 60 * 1000).unref();
  const timer = setInterval(() => cleanupExpiredHLS(getValidSongIds), DAY_MS);
  timer.unref();
  log.info('HLS_CLEAN', `HLS 缓存每日清理任务已注册，过期阈值 ${HLS_CACHE_MAX_AGE_DAYS} 天`);
}

if (!fs.existsSync(HLS_DIR)) fs.mkdirSync(HLS_DIR, { recursive: true });
// 启动时预热一次硬件加速自检，避免第一首点歌的用户额外多等这一次探测的耗时。
// 先探测 NVENC 再探测 VAAPI，与 buildVideoRendition 里的优先级顺序保持一致。
log.info('NVENC', '服务启动，开始预热 NVIDIA 显卡自检...');
detectNVENC().then(ok => {
  log.info('NVENC', `预热完成，NVIDIA 硬件加速当前${ok ? '可用' : '不可用'}`);
}).catch(() => {});
log.info('VAAPI', '服务启动，开始预热核显自检...');
detectVAAPI().then(ok => {
  log.info('VAAPI', `预热完成，核显硬件加速当前${ok ? '可用' : '不可用'}`);
}).catch(() => {});

module.exports = {
  ensureHLS, removeHLS, outDir, HLS_DIR, waitForFile, cleanupExpiredHLS, scheduleHLSCleanup,
  isBuilding, forgetBuildState, onBuildComplete,
};
