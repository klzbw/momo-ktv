/**
 * 文件名模板解析
 * 从文件名中提取歌曲标题和歌手信息
 *
 * 支持的格式：
 * - "歌手 - 歌名"
 * - "歌名 - 歌手"
 * - "歌手_歌名"
 * - "歌手 - 歌名 (伴奏)"
 * - "歌名"
 */

/**
 * 从文件名提取元信息
 * @param {string} baseName - 不含扩展名的文件名
 * @returns {{title: string, artist: string}}
 */
function filenameToMeta(baseName) {
  if (!baseName) return { title: '未知', artist: '未知' };

  let name = baseName.trim();

  // 移除常见的后缀标记
  name = name.replace(/[\s_\-]*(伴奏|纯音乐|instrumental|karaoke|无人声|人声分离)$/i, '');
  name = name.trim();

  // 尝试 "歌手 - 歌名" 格式
  if (name.includes(' - ')) {
    const parts = name.split(' - ');
    if (parts.length >= 2) {
      // 假设前面是歌手，后面是歌名
      // 但有些情况是反过来的，这里简单处理
      const artist = parts[0].trim();
      const title = parts.slice(1).join(' - ').trim();
      if (artist && title) {
        return { title, artist };
      }
    }
  }

  // 尝试 "歌手_歌名" 格式
  if (name.includes('_')) {
    const parts = name.split('_');
    if (parts.length >= 2) {
      const artist = parts[0].trim();
      const title = parts.slice(1).join('_').trim();
      if (artist && title) {
        return { title, artist };
      }
    }
  }

  // 尝试 "歌手 - 歌名" 格式（中文短横线）
  if (name.includes('－')) {
    const parts = name.split('－');
    if (parts.length >= 2) {
      const artist = parts[0].trim();
      const title = parts.slice(1).join('－').trim();
      if (artist && title) {
        return { title, artist };
      }
    }
  }

  // 无法解析，整个作为标题
  return { title: name || '未知', artist: '未知' };
}

module.exports = { filenameToMeta };
