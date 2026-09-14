/**
 * G-Box HTTP API 共享助手
 *
 * 背景：cloud-drive/index.js 里的 gboxApi 在 init() 闭包内，各 driver 文件无法直接复用。
 * 这里独立实现一个轻量、可缓存 token 的 g-box 客户端，供 quark/aliyun 等驱动
 * 扫码登录时调用 g-box 的现成实现（g-box 已维护好各网盘的签名/风控/换 cookie 细节）。
 *
 * g-box 容器：192.168.3.16:4567，账号 admin/admin。
 */

const GBOX_HOST = process.env.GBOX_HOST || '192.168.3.16';
const GBOX_PORT = parseInt(process.env.GBOX_PORT || '4567', 10);
const GBOX_USER = process.env.GBOX_USER || 'admin';
const GBOX_PASS = process.env.GBOX_PASS || 'admin';

let _token = null;
let _expireAt = 0;

function login() {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const body = JSON.stringify({ username: GBOX_USER, password: GBOX_PASS });
    const req = http.request({
      hostname: GBOX_HOST,
      port: GBOX_PORT,
      path: '/api/accounts/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.token) {
            _token = j.token;
            _expireAt = Date.now() + 3600 * 1000;
            resolve(j.token);
          } else {
            reject(new Error('G-Box 登录失败: ' + (j.message || data)));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('G-Box 连接超时')); });
    req.write(body);
    req.end();
  });
}

async function getToken() {
  if (_token && Date.now() < _expireAt) return _token;
  return login();
}

/**
 * 调用 g-box API。
 * @param {string} path  例如 /api/qrcode_quark
 * @param {string} method GET/POST
 * @param {object|null} body  JSON body
 * @param {object} opts { raw: true } 时返回二进制（用于二维码图片）
 * @returns {Promise<{status:number, json:object|null, body:string|Buffer, headers:object}>}
 */
function call(path, method = 'GET', body = null, opts = {}) {
  return getToken().then(token => new Promise((resolve, reject) => {
    const http = require('http');
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'X-ACCESS-TOKEN': token };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request({
      hostname: GBOX_HOST,
      port: GBOX_PORT,
      path,
      method,
      headers,
      timeout: 20000,
    }, (res) => {
      if (opts.raw) {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode, json: null, body: Buffer.concat(chunks), headers: res.headers });
        });
      } else {
        let text = '';
        res.on('data', c => text += c);
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch (e) { /* non-json */ }
          resolve({ status: res.statusCode, json, body: text, headers: res.headers });
        });
      }
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(new Error('G-Box API 超时')); });
    if (data) req.write(data);
    req.end();
  }));
}

module.exports = { call, getToken };
