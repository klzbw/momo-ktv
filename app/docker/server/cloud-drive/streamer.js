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
const path = require('path');

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
   * 通过账号ID和文件路径获取下载直链（带缓存）
   * 用于 STRM 文件直接包含文件路径，不需要先扫描入库
   * @param {number} accountId - cloud_accounts.id
   * @param {string} filePath - 网盘内文件路径，如 /momo-ktv/separated/abc123/vocals.flac
   * @returns {Promise<{url: string, fileName: string}>}
   */
  async getDownloadUrlByPath(accountId, filePath) {
    const cacheKey = `path:${accountId}:${filePath}`;

    // 检查缓存
    const cached = urlCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return { url: cached.url, fileName: cached.fileName };
    }

    // 获取驱动
    const driver = this.manager.getDriverById(accountId);

    // 先获取文件信息（需要 pickCode）
    const pathObj = require('path');
    const dirPath = pathObj.dirname(filePath);
    const fileName = pathObj.basename(filePath);

    const files = await driver.listFiles(dirPath);
    const targetFile = files.find((f) => f.name === fileName);
    if (!targetFile) {
      throw new Error(`网盘文件不存在: ${filePath}`);
    }

    // 获取直链（需要 pickCode）
    if (!targetFile.pickCode) {
      throw new Error(`文件没有 pickCode，无法获取直链: ${filePath}`);
    }

    const result = await driver.getDownloadUrl(targetFile.pickCode);

    // 写入缓存
    urlCache.set(cacheKey, {
      url: result.url,
      expiresAt: Math.min(result.expiresAt.getTime(), Date.now() + CACHE_TTL),
      fileName,
    });

    return { url: result.url, fileName };
  }

  /**
   * Express 中间件：处理串流请求（通过文件路径）
   * GET /api/cloud/stream-path/:accountId/*
   * 默认返回 302 重定向到网盘直链
   * ?proxy=1 时使用代理模式（带115专用User-Agent转发，解决AVPlayer无UA导致403的问题）
   */
  async handleStreamByPath(req, res) {
    try {
      const accountId = parseInt(req.params.accountId, 10);
      const filePath = '/' + (req.params[0] || '');

      if (!accountId || !filePath || filePath === '/') {
        return res.status(400).json({ error: 'accountId and filePath are required' });
      }

      // 获取直链
      const { url, fileName } = await this.getDownloadUrlByPath(accountId, filePath);

      // 代理模式：服务端带上115专用User-Agent转发流
      const useProxy = req.query.proxy === '1' || req.query.proxy === 'true';
      if (useProxy) {
        const parsed = new URL(url);
        const lib = parsed.protocol === 'https:' ? https : http;

        const headers = {
          'User-Agent': 'Mozilla/5.0 115Browser/23.9.3.2',
        };
        if (req.headers.range) {
          headers['Range'] = req.headers.range;
        }

        const proxyReq = lib.request({
          method: 'GET',
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: parsed.pathname + parsed.search,
          headers,
          timeout: 60000,
        }, (proxyRes) => {
          res.status(proxyRes.statusCode || 200);
          const passHeaders = [
            'content-length', 'content-range',
            'accept-ranges', 'cache-control', 'last-modified', 'etag',
          ];
          for (const h of passHeaders) {
            if (proxyRes.headers[h]) {
              res.setHeader(h, proxyRes.headers[h]);
            }
          }
          // 根据文件扩展名设置正确的Content-Type（115返回的是application/octet-stream，AVPlayer需要正确的视频类型）
          const ext = path.extname(filePath).toLowerCase();
          const mimeMap = {
            '.mkv': 'video/x-matroska',
            '.mp4': 'video/mp4',
            '.m4v': 'video/x-m4v',
            '.mov': 'video/quicktime',
            '.ts': 'video/mp2t',
            '.flac': 'audio/flac',
            '.mp3': 'audio/mpeg',
            '.aac': 'audio/aac',
            '.wav': 'audio/wav',
          };
          res.setHeader('Content-Type', mimeMap[ext] || proxyRes.headers['content-type'] || 'application/octet-stream');
          proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
          console.error('[CLOUD-PROXY] 代理转发错误:', err.message);
          // 直链可能过期，清除缓存后重试一次
          const cacheKey = `path:${accountId}:${filePath}`;
          urlCache.delete(cacheKey);
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

        req.on('close', () => {
          proxyReq.destroy();
        });

        proxyReq.end();
        return;
      }

      // 302 重定向（默认）
      res.setHeader('Location', url);
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return res.status(302).send();
    } catch (e) {
      console.error('通过路径获取直链失败:', e.message);
      res.status(500).json({ error: e.message });
    }
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

      // 302 直连模式（默认）：服务端返回 302 重定向，客户端直接访问网盘
      // 代理模式（?proxy=1）：服务端流式转发
      const useProxy = req.query.proxy === '1' || req.query.proxy === 'true';
      if (!useProxy && !req.query.download) {
        res.setHeader('Location', url);
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        return res.status(302).send();
      }

      // 代理模式

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
