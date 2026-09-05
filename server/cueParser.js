// CUE sheet 解析：把"一张整轨大文件(整轨 flac/ape/wav) + .cue 曲目时间表"
// 展开成多首虚拟歌曲。CUE 是纯文本，典型结构：
//
//   PERFORMER "专辑艺术家"
//   TITLE "专辑标题"
//   FILE "CDImage.ape" WAVE
//     TRACK 01 AUDIO
//       TITLE "第一首歌"
//       PERFORMER "歌手"
//       INDEX 01 00:00:00      <- mm:ss:ff，ff 是 1/75 秒的帧号
//     TRACK 02 AUDIO
//       TITLE "第二首歌"
//       INDEX 01 04:23:50
//
// 解析结果里每首歌给出 startSec；endSec 用"下一首的起点"，最后一首给 null
// (表示到整轨文件结尾，由 ffmpeg 播放到自然结束)。播放时 hlsgen 用
// -ss / -to 精确截取对应区间，对播放器而言和独立文件没有区别。

function parseCueTime(token) {
  // "04:23:50" -> 秒(浮点)
  const m = String(token || '').trim().match(/^(\d+):(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 75;
}

// 去掉 CUE 值两侧引号并 trim
function clean(v) {
  return String(v || '').replace(/^["']|["']$/g, '').trim();
}

function parseCue(text) {
  const lines = String(text || '').split(/\r?\n/);
  const result = { file: null, fileFormat: null, album: '', albumArtist: '', tracks: [] };
  let cur = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    // 命令不区分大小写；值取命令之后的整段(可能含空格)
    const sp = line.search(/\s/);
    const cmd = (sp === -1 ? line : line.slice(0, sp)).toUpperCase();
    const rest = sp === -1 ? '' : line.slice(sp + 1).trim();

    if (cmd === 'PERFORMER') {
      if (cur) cur.artist = clean(rest); else result.albumArtist = clean(rest);
    } else if (cmd === 'TITLE') {
      if (cur) cur.title = clean(rest); else result.album = clean(rest);
    } else if (cmd === 'FILE') {
      // FILE "xxx.flac" WAVE / MP3
      const fm = rest.match(/^["']?(.+?)["']?\s+[A-Z0-9]+$/);
      result.file = clean(fm ? fm[1] : rest);
      result.fileFormat = (rest.split(/\s+/).pop() || '').toUpperCase();
    } else if (cmd === 'TRACK') {
      const no = parseInt(rest, 10);
      cur = { no: Number.isFinite(no) ? no : result.tracks.length + 1, title: '', artist: '', startSec: null, index0: null };
      result.tracks.push(cur);
    } else if (cmd === 'INDEX') {
      // INDEX 01 mm:ss:ff  (00 是预间隙，播放用 01)
      const im = rest.match(/^(\d+)\s+(\d+:\d{1,2}:\d{1,2})/);
      if (im && cur) {
        const t = parseCueTime(im[2]);
        if (im[1] === '01') cur.startSec = t;
        else if (im[1] === '00') cur.index0 = t;
      }
    }
  }
  // 计算每首结束时间 = 下一首起点；最后一首 null(到文件尾)
  for (let i = 0; i < result.tracks.length; i++) {
    const next = result.tracks[i + 1];
    result.tracks[i].endSec = next ? next.startSec : null;
    // 歌手缺省回退到专辑艺术家
    if (!result.tracks[i].artist) result.tracks[i].artist = result.albumArtist || '';
  }
  // 只保留有合法起点的音轨
  result.tracks = result.tracks.filter(t => t.startSec !== null);
  return result;
}

module.exports = { parseCue, parseCueTime };
