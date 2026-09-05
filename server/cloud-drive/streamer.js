/**
 * 网盘串流代理 - Gbox AList 版本
 * 提供 /api/cloud/stream/:file_id 和 /api/cloud/stream-path/:accountId/* 端点
 * 自动获取网盘直链并返回 302 重定向（不占 NAS 带宽）
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

// 直链内存缓存：filePath -> { url, expiresAt }
const urlCache = new Map();
const CACHE_TTL = 25 * 60 * 1000; // 25分钟缓存

class CloudDriveStreamer {
  constructor(manager) {
    this.manager = manager;
    this.alistEnabled = true;
    this.alistUrl = 'http://192.168.3.16:5234'; // Gbox AList
    this.alistToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VybmFtZSI6ImFkbWluIiwicHdkX3RzIjoxNzg4NjIzNDA4LCJleHAiOjE4MDU5MDM5ODQsIm5iZiI6MTc4ODYyMzk4NCwiaWF0IjoxNzg4NjIzOTg0fQ.5XzN8q2T1jEaO8yoV8eTj6gZzBmDUtr1ijUuM48QD9w';
    this.alistBasePath = '/🥝115网盘/115';
    console.log('[Streamer] AList enabled:', this.alistEnabled);
    console.log('[Streamer] AList URL:', this.alistUrl);
    console.log('[Streamer] AList base path:', this.alistBasePath);
  }

  /**
   * 从 AList 获取文件直链
   */
  async getAlistDirectUrl(filePath) {
    try {
      const fullPath = this.alistBasePath + '/' + filePath;
      console.log('[Streamer] Getting direct URL for:', fullPath);
      
      const postData = JSON.stringify({
        path: fullPath,
        password: ''
      });
      
      const url = new URL(this.alistUrl + '/api/fs/get');
      const isHttps = url.protocol === 'https:';
      const options = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'Authorization': this.alistToken
        },
        timeout: 30000
      };
      
      const client = isHttps ? https : http;
      
      return new Promise((resolve, reject) => {
        const req = client.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              const result = JSON.parse(data);
              if (result.code === 200 && result.data && result.data.raw_url) {
                console.log('[Streamer] Got direct URL:', result.data.raw_url.substring(0, 100) + '...');
                resolve(result.data.raw_url);
              } else {
                console.error('[Streamer] Failed to get direct URL:', result.message || 'unknown');
                resolve(null);
              }
            } catch (e) {
              console.error('[Streamer] Parse error:', e.message);
              resolve(null);
            }
          });
        });
        req.on('error', (e) => {
          console.error('[Streamer] Request error:', e.message);
          resolve(null);
        });
        req.on('timeout', () => {
          req.destroy();
          resolve(null);
        });
        req.write(postData);
        req.end();
      });
    } catch (error) {
      console.error('[Streamer] Error getting direct URL:', error.message);
      return null;
    }
  }

  /**
   * 获取文件直链（带缓存）
   */
  async getDirectUrl(filePath) {
    const cacheKey = filePath;
    const cached = urlCache.get(cacheKey);
    
    if (cached && cached.expiresAt > Date.now()) {
      console.log('[Streamer] Using cached URL for:', filePath);
      return cached.url;
    }
    
    const directUrl = await this.getAlistDirectUrl(filePath);
    
    if (directUrl) {
      urlCache.set(cacheKey, {
        url: directUrl,
        expiresAt: Date.now() + CACHE_TTL
      });
    }
    
    return directUrl;
  }

  /**
   * 通过文件路径串流（302 重定向到直链）
   * 用于 /api/cloud/stream-path/:accountId/* 端点
   */
  async handleStreamByPath(req, res) {
    try {
      // Extract file path from URL
      // URL format: /api/cloud/stream-path/:accountId/*
      const accountId = req.params.accountId;
      const filePath = req.params[0] || '';
      
      console.log('[Streamer] handleStreamByPath:', accountId, filePath);
      
      if (!filePath) {
        res.status(400).json({ error: 'File path is required' });
        return;
      }
      
      const directUrl = await this.getDirectUrl(filePath);
      
      if (!directUrl) {
        res.status(500).json({ error: 'Failed to get direct URL' });
        return;
      }
      
      // Return 302 redirect to direct URL
      console.log('[Streamer] Redirecting to:', directUrl.substring(0, 100) + '...');
      res.redirect(302, directUrl);
      
    } catch (error) {
      console.error('[Streamer] handleStreamByPath error:', error.message);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message });
      }
    }
  }

  /**
   * 通过文件 ID 串流
   * 用于 /api/cloud/stream/:file_id 端点
   */
  async handleStream(req, res) {
    try {
      const fileId = req.params.file_id;
      console.log('[Streamer] handleStream:', fileId);
      
      // For now, we don't have a file ID to path mapping
      // Use handleStreamByPath logic instead
      res.status(501).json({ error: 'Not implemented, use /api/cloud/stream-path/:accountId/* instead' });
      
    } catch (error) {
      console.error('[Streamer] handleStream error:', error.message);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message });
      }
    }
  }
}

module.exports = CloudDriveStreamer;
