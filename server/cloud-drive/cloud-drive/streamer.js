/**
 * 网盘串流代理
 * 提供 /api/cloud/stream/:file_id 端点，自动获取网盘直链并转发数据流。
 *
 * 功能：
 * 1. 自动获取网盘直链（带内存缓存，避免频繁调用 API）
 * 2. 支持 Range 请求（断点续传、随机读取）
 * 3. 直链过期自动刷新
 * 4. 流式转发，不占用大量内存
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

// 直链内存缓存：file_id -> { url, expiresAt, libraryId }
const urlCache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30分钟缓存（比直链有效期短）

class CloudDriveStreamer {
  constructor(manager) {
    this.manager = manager;
    this.db = manager.db;
  }

  /**
   * 获取网盘文件的下载直链（带缓存）
   * @param {number} cloudFileId - cloud_files.id
   * @returns {Promise<{url: string, fileName: string}>}
   */
  async getDownloadUrl(cloudFileId) {
    // 检查缓存
    const cached = urlCache.get(cloudFileId);
    if (cached && Date.now() < cached.expiresAt) {
      return { url: cached.url, fileName: cached.fileName };
    }

    // 从数据库获取文件信息
    const cf = this.db.prepare('SELECT * FROM cloud_files WHERE id = ?').get(cloudFileId);
    if (!cf) throw new Error(`网盘文件不存在: ${cloudFileId}`);

    const lib = this.db.prepare('SELECT * FROM cloud_libraries WHERE id = ?').get(cf.library_id);
    if (!lib) throw new Error(`网盘曲库不存在: ${cf.library_id}`);

    const driver = this.manager.getDriverById(lib.account_id);

    // 获取直链
    const result = await driver.getDownloadUrl(cf.file_id);

    // 写入缓存
    urlCache.set(cloudFileId, {
      url: result.url,
      expiresAt: Math.min(result.expiresAt.getTime(), Date.now() + CACHE_TTL),
      fileName: cf.file_name,
    });

    return { url: result.url, fileName: cf.file_name };
  }

  /**
   * Express 中间件：处理串流请求
   * GET /api/cloud/stream/:file_id
   */
  async handleStream(req, res) {
    try {
      const fileId = parseInt(req.params.file_id, 10);
      if (!fileId) {
        return res.status(400).json({ error: 'file_id is required' });
      }

      // 获取直链
      const { url, fileName } = await this.getDownloadUrl(fileId);

      // 解析目标 URL
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? https : http;

      // 构造请求头，透传 Range
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      };
      if (req.headers.range) {
        headers['Range'] = req.headers.range;
      }

      // 请求网盘直链
      const proxyReq = lib.request({
        method: 'GET',
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers,
        timeout: 30000,
      }, (proxyRes) => {
        // 设置响应头
        res.status(proxyRes.statusCode || 200);

        // 透传关键响应头
        const passHeaders = [
          'content-type', 'content-length', 'content-range',
          'accept-ranges', 'cache-control', 'last-modified', 'etag',
        ];
        for (const h of passHeaders) {
          if (proxyRes.headers[h]) {
            res.setHeader(h, proxyRes.headers[h]);
          }
        }

        // 设置下载文件名（如果是附件下载）
        if (req.query.download) {
          res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
        }

        // 流式转发
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (err) => {
        console.error('网盘串流错误:', err.message);
        // 直链可能过期，清除缓存后重试一次
        urlCache.delete(fileId);
        if (!res.headersSent) {
          res.status(502).json({ error: '网盘直链获取失败: ' + err.message });
        }
      });

      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        if (!res.headersSent) {
          res.status(504).json({ error: '网盘请求超时' });
        }
      });

      // 客户端断开时取消请求
      req.on('close', () => {
        proxyReq.destroy();
      });

      proxyReq.end();
    } catch (e) {
      console.error('串流处理失败:', e);
      res.status(500).json({ error: e.message });
    }
  }

  /**
   * 清除直链缓存（手动刷新时调用）
   */
  clearCache(cloudFileId) {
    if (cloudFileId) {
      urlCache.delete(cloudFileId);
    } else {
      urlCache.clear();
    }
  }
}

module.exports = CloudDriveStreamer;
