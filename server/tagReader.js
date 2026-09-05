// 音频标签刮削：用 ffprobe 读取纯音频文件内嵌的 ID3/ Vorbis Comment /
// ape tag 等元数据(歌名/歌手/专辑/年份/音轨号)与精确时长。
// 纯音频文件没有"歌手-歌名-语种-风格"这种规范文件名时，靠内嵌标签得到
// 正确的歌名/歌手；读不到标签时由调用方回退到文件名解析(parseFilename)。
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// ffprobe 返回的 tags 键名大小写/命名不完全统一，做容错查找
function pickTag(tags, ...keys) {
  if (!tags) return '';
  for (const k of keys) {
    for (const tk of Object.keys(tags)) {
      if (tk.toLowerCase() === k.toLowerCase() && tags[tk] != null && String(tags[tk]).trim() !== '') {
        return String(tags[tk]).trim();
      }
    }
  }
  return '';
}

// 返回 { title, artist, album, year, trackNo, durationSec }
// 任何失败都返回空字段(不抛)，由调用方决定回退策略。
async function readAudioTags(filepath) {
  const empty = { title: '', artist: '', album: '', year: '', trackNo: null, durationSec: null };
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration:format_tags=title,artist,album_artist,album,date,track,TIT2,TPE1,TALB,TYER',
      '-of', 'json',
      filepath,
    ], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    const fmt = JSON.parse(stdout).format || {};
    const tags = fmt.tags || {};
    const durationSec = Number.isFinite(parseFloat(fmt.duration)) ? Math.round(parseFloat(fmt.duration)) : null;
    // track 可能是 "3/12"，只取斜杠前的序号
    let trackNo = null;
    const trackRaw = pickTag(tags, 'track');
    if (trackRaw) {
      const n = parseInt(String(trackRaw).split('/')[0], 10);
      if (Number.isFinite(n)) trackNo = n;
    }
    return {
      title: pickTag(tags, 'title', 'TIT2'),
      artist: pickTag(tags, 'artist', 'album_artist', 'TPE1'),
      album: pickTag(tags, 'album', 'TALB'),
      year: (pickTag(tags, 'date', 'TYER') || '').slice(0, 4),
      trackNo,
      durationSec,
    };
  } catch (e) {
    return empty;
  }
}

// 判断 ffprobe 看到的流里是否存在视频流(用于区分一个文件到底是不是纯音频)。
// 返回 'audio' | 'video'，探测失败返回 null。
async function probeMediaType(filepath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', filepath,
    ], { timeout: 30000 });
    const streams = JSON.parse(stdout).streams || [];
    if (streams.some(s => s.codec_type === 'video')) return 'video';
    if (streams.some(s => s.codec_type === 'audio')) return 'audio';
    return null;
  } catch (e) {
    return null;
  }
}

module.exports = { readAudioTags, probeMediaType };
