const express = require('express');
const router = express.Router();

// 内置 Gbox alist 配置（集成在 momo-ktv 镜像中）
const ALIST_BASE_URL = 'http://localhost:5234';
const ALIST_BASE_PATH = '/🥝115网盘/115';

/**
 * Handle stream request - redirect to 内置 Gbox alist /d/ 端点
 * Gbox alist 处理 115 CDN 认证（cookies、headers）
 */
router.get('/*', async (req, res) => {
  try {
    const filePath = req.params[0] || '';
    console.log('[DirectStream] Request:', filePath);

    if (!filePath) {
      return res.status(400).json({ error: 'File path is required' });
    }

    // 使用内置 Gbox alist /d/ 端点
    const fullPath = ALIST_BASE_PATH + '/' + filePath;
    const encodedPath = encodeURIComponent(fullPath).replace(/%2F/g, '/');
    const alistUrl = ALIST_BASE_URL + '/d/' + encodedPath;
    
    console.log('[DirectStream] Redirecting to built-in alist:', alistUrl);

    // 302 重定向到内置 Gbox alist
    res.redirect(302, alistUrl);
  } catch (error) {
    console.error('[DirectStream] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
