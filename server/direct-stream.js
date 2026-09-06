const express = require('express');
const router = express.Router();

// 内置 Gbox alist 配置（集成在 momo-ktv 镜像中）
// 注意：端口必须与 alist-config.json 的 http_port 一致（5235）
// 挂载路径必须与 alist-init.sh 的 mount_path 一致（/115）
const ALIST_BASE_URL = process.env.ALIST_BASE_URL || 'http://localhost:5235';
const ALIST_BASE_PATH = process.env.ALIST_BASE_PATH || '/115';

/**
 * Handle stream request - redirect to 内置 Gbox alist /d/ 端点
 * Gbox alist 处理 115 CDN 认证（cookies、headers）
 * 客户端（tvOS VLC / 网页）自动跟随 302，直接从 115 CDN 拉取数据
 * NAS 只参与本次轻量 302 跳转，不转发媒体数据，不占带宽和容量
 */
router.get('/*', async (req, res) => {
  try {
    // Express 通配符路由可能返回编码后的路径，先解码再统一编码
    let filePath = req.params[0] || '';
    try { filePath = decodeURIComponent(filePath); } catch (e) { /* 已经是解码后的 */ }
    console.log('[DirectStream] Request:', filePath);

    if (!filePath) {
      return res.status(400).json({ error: 'File path is required' });
    }

    // 使用内置 Gbox alist /d/ 端点
    // filePath 是相对于 Alist 挂载点的路径，如 ktv-output/xxx.mkv
    // 去掉前导斜杠，避免拼接后出现 /d//115/... 双斜杠
    const basePath = ALIST_BASE_PATH.replace(/^\/+/, '');
    const relPath = filePath.replace(/^\/+/, '');
    const fullPath = basePath ? `${basePath}/${relPath}` : relPath;
    const encodedPath = encodeURIComponent(fullPath).replace(/%2F/g, '/');
    const alistUrl = ALIST_BASE_URL + '/d/' + encodedPath;

    console.log('[DirectStream] Redirecting to built-in alist:', alistUrl);

    // 302 重定向到内置 Gbox alist
    // Alist 会再次 302 到 115 CDN 真实直链
    res.redirect(302, alistUrl);
  } catch (error) {
    console.error('[DirectStream] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
