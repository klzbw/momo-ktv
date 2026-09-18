/**
 * 部署 webhook（增量新增，不影响现有逻辑）
 *
 * 用途：GitHub Actions 构建并推送 ghcr.io/klzbw/momo-ktv:latest 成功后，
 *       回调本端点，自动拉取新镜像并用新镜像重建 momo-ktv 容器。
 *
 * 安全：
 *  - 必须带正确 token：GET/POST /api/deploy/webhook?token=xxx
 *  - token 来自环境变量 DEPLOY_WEBHOOK_TOKEN；未配置则端点直接 404（视为未启用）
 *  - token 不匹配一律 403
 *  - 不接收任何请求参数拼进命令，全程走 Docker Engine UNIX Socket API（/var/run/docker.sock），
 *    不存在 shell 注入面。
 *
 * 部署动作（等价于 docker compose pull && docker compose up -d）：
 *  1. POST /images/create?fromImage=<image>&tag=latest   拉新镜像
 *  2. GET  /containers/momo-ktv/json                     读当前容器配置
 *  3. 比较新旧镜像 ID；不同则 stop -> rm -> create(复用原 Config/HostConfig) -> start
 */
'use strict';

const http = require('http');
const fs = require('fs');

const SOCKET = process.env.DEPLOY_DOCKER_SOCKET || '/var/run/docker.sock';
const IMAGE = process.env.DEPLOY_IMAGE || 'ghcr.io/klzbw/momo-ktv';
const CONTAINER = process.env.DEPLOY_CONTAINER || 'momo-ktv';

const state = {
  running: false,
  lastResult: null,
  lastTime: null,
};

function dockerReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ socketPath: SOCKET, path, method, headers, timeout: 0 }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function deploy() {
  if (state.running) return { skipped: true, reason: 'already running' };
  state.running = true;
  const startedAt = new Date().toISOString();
  try {
    if (!fs.existsSync(SOCKET)) throw new Error('docker socket 不存在: ' + SOCKET);

    // 1. 记录当前容器镜像
    const before = await dockerReq('GET', `/containers/${CONTAINER}/json`);
    if (before.status !== 200) throw new Error('读取容器失败: HTTP ' + before.status + ' ' + before.body.slice(0, 200));
    const beforeJson = JSON.parse(before.body);
    const oldImageId = beforeJson.Image;

    // 2. 拉新镜像（流式，等待完成）
    const pull = await dockerReq('POST', `/images/create?fromImage=${encodeURIComponent(IMAGE)}&tag=latest`);
    if (pull.status < 200 || pull.status >= 300) throw new Error('拉取镜像失败: HTTP ' + pull.status + ' ' + pull.body.slice(0, 300));

    // 3. 新镜像 ID
    const inspectNew = await dockerReq('GET', `/images/${IMAGE}:latest/json`);
    if (inspectNew.status !== 200) throw new Error('读取新镜像失败: HTTP ' + inspectNew.status);
    const newImageId = JSON.parse(inspectNew.body).Id;

    if (newImageId === oldImageId) {
      const result = { ok: true, changed: false, oldImageId, newImageId, msg: '镜像无变化，无需重建' };
      state.lastResult = result; state.lastTime = startedAt;
      console.log('[DEPLOY]', result.msg);
      return result;
    }

    // 4. 重建容器：复用原 Config / HostConfig，名字不变
    const createBody = {
      Image: `${IMAGE}:latest`,
      name: CONTAINER,
      Config: beforeJson.Config,
      HostConfig: beforeJson.HostConfig,
    };
    await dockerReq('POST', `/containers/${CONTAINER}/stop?t=15`).catch(() => {});
    await dockerReq('DELETE', `/containers/${CONTAINER}?force=true`);
    const create = await dockerReq('POST', '/containers/create', createBody);
    if (create.status < 200 || create.status >= 300) throw new Error('创建容器失败: HTTP ' + create.status + ' ' + create.body.slice(0, 300));
    const newId = JSON.parse(create.body).Id;
    const start = await dockerReq('POST', `/containers/${newId}/start`);
    if (start.status < 200 || start.status >= 300) throw new Error('启动容器失败: HTTP ' + start.status + ' ' + start.body.slice(0, 300));

    const result = { ok: true, changed: true, oldImageId, newImageId, newContainerId: newId, msg: '已拉新镜像并重建容器' };
    state.lastResult = result; state.lastTime = startedAt;
    console.log('[DEPLOY]', result.msg);
    return result;
  } catch (e) {
    console.error('[DEPLOY] 失败:', e.message);
    const result = { ok: false, error: e.message };
    state.lastResult = result; state.lastTime = startedAt;
    return result;
  } finally {
    state.running = false;
  }
}

function register(app) {
  const token = process.env.DEPLOY_WEBHOOK_TOKEN;

  // 状态查询
  app.get('/api/deploy/status', (req, res) => {
    res.json({ enabled: !!token, running: state.running, lastResult: state.lastResult, lastTime: state.lastTime });
  });

  // webhook 触发
  app.post('/api/deploy/webhook', (req, res) => {
    if (!token) return res.status(404).json({ error: 'deploy webhook 未启用（未配置 DEPLOY_WEBHOOK_TOKEN）' });
    const got = req.query.token || '';
    if (typeof got !== 'string' || got !== token) return res.status(403).json({ error: 'token 不匹配' });

    // 异步执行，立即响应；GitHub 回调不需要等容器重建完成
    res.json({ ok: true, msg: '部署已触发', container: CONTAINER, image: IMAGE });
    deploy().catch(() => {});
  });

  console.log('[DEPLOY] webhook 端点已注册: POST /api/deploy/webhook (token ' + (token ? '已配置' : '未配置') + ')');
}

module.exports = { register, deploy };
