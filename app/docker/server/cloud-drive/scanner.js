/**
 * 网盘文件扫描器
 * 递归遍历网盘目录，过滤媒体文件，写入 cloud_files 表，并生成 songs 记录。
 *
 * 扫描流程：
 * 1. 从 cloud_libraries 获取挂载路径
 * 2. 递归调用驱动 listFiles() 遍历目录
 * 3. 过滤媒体文件（mkv/mp4/flac/mp3/wav/ape/ogg/aac/strm）
 * 4. 写入 cloud_files 表
 * 5. 解析文件名 → 提取标题/歌手 → 写入 songs 表（source_type=cloud）
 * 6. 更新 cloud_libraries.scan_status 和 song_count
 */

const path = require('path');
const { filenameToMeta } = require('./filenameTemplate');

// 支持的媒体文件扩展名
const MEDIA_EXTENSIONS = new Set([
  '.mkv', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm',
  '.flac', '.mp3', '.wav', '.ape', '.ogg', '.aac', '.wma', '.m4a',
  '.strm', '.cue',
]);

class CloudDriveScanner {
  constructor(manager) {
    this.manager = manager;
    this.db = manager.db;
  }

  /**
   * 扫描指定网盘曲库
   * @param {number} libraryId - cloud_libraries.id
   * @returns {Promise<{scanned: number, added: number, errors: number}>}
   */
  async scanLibrary(libraryId) {
    const libraries = this.manager.listLibraries();
    const lib = libraries.find((l) => l.id === libraryId);
    if (!lib) throw new Error(`曲库不存在: ${libraryId}`);

    const driver = this.manager.getDriverById(lib.account_id);

    this.manager.updateLibraryScanStatus(libraryId, 'scanning', 0);

    let scanned = 0;
    let added = 0;
    let errors = 0;

    try {
      // 递归遍历网盘目录
      const allFiles = await this._recursiveList(driver, lib.mount_path);
      scanned = allFiles.length;

      // 过滤媒体文件
      const mediaFiles = allFiles.filter((f) => {
        const ext = path.extname(f.name).toLowerCase();
        return MEDIA_EXTENSIONS.has(ext);
      });

      // 写入 cloud_files 表
      const insertFile = this.db.prepare(`
        INSERT OR REPLACE INTO cloud_files
          (library_id, file_id, file_path, file_name, file_size)
        VALUES (?, ?, ?, ?, ?)
      `);

      const tx = this.db.transaction((files) => {
        for (const f of files) {
          insertFile.run(libraryId, f.fileId, f.path, f.name, f.size);
        }
      });
      tx(mediaFiles);

      // 生成 songs 记录
      for (const f of mediaFiles) {
        try {
          const songId = this._ensureSong(libraryId, f);
          if (songId) added++;
        } catch (e) {
          errors++;
          console.error(`入库失败: ${f.name}`, e.message);
        }
      }

      this.manager.updateLibraryScanStatus(libraryId, 'done', mediaFiles.length);
      return { scanned, added, errors, mediaFiles: mediaFiles.length };
    } catch (e) {
      this.manager.updateLibraryScanStatus(libraryId, 'error', 0);
      throw e;
    }
  }

  /**
   * 递归列出网盘目录下的所有文件
   */
  async _recursiveList(driver, remotePath, depth = 0) {
    if (depth > 10) return []; // 防止无限递归

    let files = [];
    try {
      const items = await driver.listFiles(remotePath);
      for (const item of items) {
        if (item.isDir) {
          // 递归子目录
          const subFiles = await this._recursiveList(driver, item.path, depth + 1);
          files = files.concat(subFiles);
        } else {
          files.push(item);
        }
      }
    } catch (e) {
      console.error(`遍历目录失败: ${remotePath}`, e.message);
    }
    return files;
  }

  /**
   * 确保歌曲记录存在（source_type=cloud）
   * @returns {number|null} song.id
   */
  _ensureSong(libraryId, fileInfo) {
    // 检查是否已存在
    const existing = this.db.prepare(
      'SELECT id FROM songs WHERE cloud_file_id IN (SELECT id FROM cloud_files WHERE library_id = ? AND file_id = ?)'
    ).get(libraryId, fileInfo.fileId);

    if (existing) return existing.id;

    // 获取 cloud_files.id
    const cf = this.db.prepare(
      'SELECT id FROM cloud_files WHERE library_id = ? AND file_id = ?'
    ).get(libraryId, fileInfo.fileId);
    if (!cf) return null;

    // 解析文件名获取标题和歌手
    const ext = path.extname(fileInfo.name);
    const baseName = fileInfo.name.slice(0, -ext.length);
    const meta = filenameToMeta(baseName);

    // 生成唯一 filename（cloud_前缀 + file_id）
    const filename = `cloud_${libraryId}_${fileInfo.fileId}${ext}`;

    // 检查 filename 是否已存在
    const existingByFilename = this.db.prepare('SELECT id FROM songs WHERE filename = ?').get(filename);
    if (existingByFilename) {
      this.db.prepare('UPDATE songs SET cloud_file_id = ? WHERE id = ?').run(cf.id, existingByFilename.id);
      return existingByFilename.id;
    }

    // 插入歌曲记录
    const info = this.db.prepare(`
      INSERT INTO songs
        (title, artist, filename, filepath, source_type, cloud_file_id, audio_tracks, cache_status)
      VALUES (?, ?, ?, ?, 'cloud', ?, NULL, 'cloud')
    `).run(
      meta.title || baseName,
      meta.artist || '未知',
      filename,
      fileInfo.path, // 网盘路径，播放时通过 cloud_file_id 获取直链
      cf.id,
    );

    return info.lastInsertRowid;
  }

  /**
   * 增量扫描（对比已有文件，只处理新增/删除）
   * 简化版：先全量扫描，后续优化
   */
  async incrementalScan(libraryId) {
    return this.scanLibrary(libraryId);
  }
}

module.exports = CloudDriveScanner;
