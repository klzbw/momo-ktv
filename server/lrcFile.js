// lrcFile.js —— 逐字歌词 .lrc 文件的本地读写工具
//
// 设计目的：
//   把 songs.lyrics_word（逐字时间戳文本，格式 [mm:ss.xx]<mm:ss.xx>字...）
//   作为独立的 .lrc 文件随分离产物一起分发（115 网盘），让全国用户
//   挂载后扫描即可获得逐字歌词，不需要再跑 GPU WhisperX 对齐。
//
// 文件位置约定：
//   /data/separated/<sha>/<sha>.lrc
//   其中 <sha> 是分离产物目录名（源文件路径 SHA256 前16位），
//   与 vocal_path/accomp_path 里的目录段一致。
//
// 这个模块只做文件 IO，不碰数据库。数据库读写由调用方负责。

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const SEP_DIR = path.join(DATA_DIR, 'separated');

/**
 * 从 vocal_path / accomp_path / filepath 中提取 16 位 hex 的 sha 目录名。
 * 支持格式：
 *   separated/<sha>/xxx.flac
 *   netseparated-strm/<sha>_vocals.strm
 *   /data/separated/<sha>/xxx.flac
 * @param {string} p
 * @returns {string|null}
 */
function extractSha(p) {
  if (!p) return null;
  const s = String(p);
  // separated/<sha>/ 或 netseparated-strm/<sha>_
  let m = s.match(/separated[\/\\]([0-9a-fA-F]{16})[\/\\]/);
  if (m) return m[1];
  m = s.match(/netseparated-strm[\/\\]([0-9a-fA-F]{16})_/);
  if (m) return m[1];
  return null;
}

/**
 * 取某首歌对应的 .lrc 文件绝对路径。sha 从 vocal_path 提取，
 * 提取不到则从 filepath 算 SHA256 前16位（与 separate.js sepKey 一致）。
 * @param {object} songRow 至少含 vocal_path, accomp_path, filepath
 * @returns {string|null}
 */
function lrcPathForSong(songRow) {
  if (!songRow) return null;
  let sha = extractSha(songRow.vocal_path) || extractSha(songRow.accomp_path);
  if (!sha && songRow.filepath) {
    const crypto = require('crypto');
    sha = crypto.createHash('sha256').update(String(songRow.filepath)).digest('hex').slice(0, 16);
  }
  if (!sha) return null;
  return path.join(SEP_DIR, sha, sha + '.lrc');
}

/**
 * 把 lyrics_word 写入 <sha>.lrc 文件。目录不存在则创建。
 * @param {string} sha
 * @param {string} lyricsWord
 * @returns {string|null} 写入的文件路径，失败返回 null
 */
function writeLrcFile(sha, lyricsWord) {
  if (!sha || !lyricsWord) return null;
  try {
    const dir = path.join(SEP_DIR, sha);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, sha + '.lrc');
    fs.writeFileSync(p, lyricsWord, 'utf8');
    return p;
  } catch (e) {
    console.error('[lrcFile] 写入失败:', sha, e.message);
    return null;
  }
}

/**
 * 读 <sha>.lrc 文件内容。文件不存在或不可读返回 null。
 * @param {string} sha
 * @returns {string|null}
 */
function readLrcFile(sha) {
  if (!sha) return null;
  try {
    const p = path.join(SEP_DIR, sha, sha + '.lrc');
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    return null;
  }
}

/**
 * 给定 songRow，把 lyricsWord 回写为 .lrc 文件（如果对应 separated 目录存在）。
 * 封装了"先算 sha、再判断目录是否存在、再写文件"这一套调用方常用流程。
 * @param {object} songRow 至少含 vocal_path, accomp_path, filepath
 * @param {string} lyricsWord
 * @returns {string|null}
 */
function writeLrcForSong(songRow, lyricsWord) {
  if (!songRow || !lyricsWord) return null;
  let sha = extractSha(songRow.vocal_path) || extractSha(songRow.accomp_path);
  if (!sha && songRow.filepath) {
    const crypto = require('crypto');
    sha = crypto.createHash('sha256').update(String(songRow.filepath)).digest('hex').slice(0, 16);
  }
  if (!sha) return null;
  // 只有 separated 目录实际存在才写（避免为没有分离产物的歌凭空建目录）
  const dir = path.join(SEP_DIR, sha);
  if (!fs.existsSync(dir)) return null;
  return writeLrcFile(sha, lyricsWord);
}

module.exports = {
  SEP_DIR,
  extractSha,
  lrcPathForSong,
  writeLrcFile,
  readLrcFile,
  writeLrcForSong,
};
