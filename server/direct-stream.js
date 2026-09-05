const express = require('express');
const router = express.Router();

// Gbox alist configuration
const ALIST_BASE_URL = 'http://192.168.3.16:5234';
const ALIST_BASE_PATH = '/🥝115网盘/115';

// Cache for direct URLs (to avoid frequent alist API calls)
const urlCache = new Map();
const CACHE_TTL = 25 * 60 * 1000; // 25 minutes

/**
 * Get direct URL from Gbox alist
 */
async function getAlistDirectUrl(filePath) {
  const cacheKey = filePath;
  const cached = urlCache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return cached.url;
  }

  try {
    // Use Gbox alist /d/ endpoint directly (it handles 302 redirect with proper headers)
    const fullPath = ALIST_BASE_PATH + '/' + filePath;
    const encodedPath = encodeURIComponent(fullPath).replace(/%2F/g, '/');
    const alistUrl = ALIST_BASE_URL + '/d/' + encodedPath;
    
    urlCache.set(cacheKey, { url: alistUrl, time: Date.now() });
    return alistUrl;
  } catch (error) {
    console.error('[DirectStream] Failed to get alist URL:', error.message);
    throw error;
  }
}

/**
 * Handle stream request - redirect to Gbox alist /d/ endpoint
 * Gbox alist handles 115 CDN authentication properly (cookies, headers)
 */
router.get('/*', async (req, res) => {
  try {
    const filePath = req.params[0] || '';
    console.log('[DirectStream] Request:', filePath);

    if (!filePath) {
      return res.status(400).json({ error: 'File path is required' });
    }

    // Get Gbox alist URL (which handles 115 CDN authentication)
    const alistUrl = await getAlistDirectUrl(filePath);
    console.log('[DirectStream] Redirecting to alist:', alistUrl);

    // 302 redirect to Gbox alist /d/ endpoint
    // Gbox alist will then redirect to 115 CDN with proper authentication
    res.redirect(302, alistUrl);
  } catch (error) {
    console.error('[DirectStream] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
