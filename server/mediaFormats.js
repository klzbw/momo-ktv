// 媒体格式统一定义：视频容器、纯音频、CUE 整轨索引。
// 历史上 scanner.js 里只有一份 VIDEO_EXT 白名单，纯音频(mp3/flac/wav/ape 等)
// 无法入库。音频 K 歌改造把"支持哪些文件"集中到这里，扫描器、HLS、后台都
// 引用同一份定义，避免各处各写一份扩展名导致行为不一致。

// 视频/带画面容器：原有 7 种 + 常见的 mpeg/m4v/ts/wmv/rmvb/vob。
// 这些走原来的"视频轨 + 音频轨"HLS 管线，非 h264 编码由 hlsgen 自动转码。
const VIDEO_EXT = [
  '.mp4', '.mkv', '.avi', '.flv', '.mov', '.webm', '.mpg',
  '.mpeg', '.m4v', '.ts', '.wmv', '.rmvb', '.rm', '.vob', '.3gp',
];

// 纯音频容器：Debian bookworm 自带 ffmpeg 5.x 已内置这些解码器
// (mp3/flac/wav/pcm/aac/vorbis/opus/wma/ape 等)，无需额外安装，
// APE 由 ffmpeg 上游 apedec 支持。纯音频没有视频轨，HLS 阶段会用动态
// 背景补一条视频轨(见 hlsgen.js)，从而复用整套视频播放链路。
const AUDIO_EXT = [
  '.mp3', '.flac', '.wav', '.ape', '.m4a', '.aac',
  '.ogg', '.wma', '.opus', '.aif', '.aiff',
];

// CUE 不是音频本身，而是"一张整轨大碟 + 每首歌起止时间"的索引文本，
// 扫描时把它展开成多首虚拟歌曲(见 cueParser.js)。
const CUE_EXT = '.cue';
// STRM 文本指针(原有)
const STRM_EXT = '.strm';

const isVideoExt = (ext) => VIDEO_EXT.includes(String(ext || '').toLowerCase());
const isAudioExt = (ext) => AUDIO_EXT.includes(String(ext || '').toLowerCase());
const isCueExt = (ext) => String(ext || '').toLowerCase() === CUE_EXT;
// 任何可以入库的媒体/索引文件
const isCollectableExt = (ext) => isVideoExt(ext) || isAudioExt(ext) || isCueExt(ext) || String(ext || '').toLowerCase() === STRM_EXT;
// 'video' | 'audio' | null
const mediaTypeOf = (ext) => isAudioExt(ext) ? 'audio' : (isVideoExt(ext) ? 'video' : null);

module.exports = {
  VIDEO_EXT, AUDIO_EXT, CUE_EXT, STRM_EXT,
  isVideoExt, isAudioExt, isCueExt, isCollectableExt, mediaTypeOf,
};
