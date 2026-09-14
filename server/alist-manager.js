/**
 * AList 进程管理模块
 *
 * 功能：
 * 1. 容器启动时自动启动 /opt/alist/alist server
 * 2. 配置 AList 端口 5234，管理员密码 admin123
 * 3. 健康检查与自动重启
 * 4. 提供 start/stop/status API
 *
 * 设计原则：
 * - AList 数据目录存 /data/alist/（持久化挂载）
 * - 不阻塞主进程启动，AList 启动失败仅警告
 * - 子进程退出时自动重启（最多重试5次）
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

let _alistProcess = null;
let _restartCount = 0;
const MAX_RESTARTS = 5;
let _dataDir = '/data';
let _alistBin = '/opt/alist/alist';
let _alistPort = 5234;
let _adminPassword = 'admin123';
let _starting = false;
let _stopping = false;
let _externalAlist = false; // entrypoint 已启动的 AList

/**
 * 检查 AList 是否已经在运行（可能由容器 entrypoint 启动）
 */
async function _isAlistRunning() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${_alistPort}/api/public/settings`, { timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * 初始化 AList 管理器
 */
function init(dataDir) {
  _dataDir = dataDir || '/data';
  _alistBin = process.env.ALIST_BIN || '/opt/alist/alist';
  _alistPort = parseInt(process.env.ALIST_PORT || '5234', 10);
  _adminPassword = process.env.ALIST_ADMIN_PASSWORD || 'admin123';

  // 确保数据目录存在
  const alistDataDir = path.join(_dataDir, 'alist');
  if (!fs.existsSync(alistDataDir)) {
    try {
      fs.mkdirSync(alistDataDir, { recursive: true });
      console.log('[AListManager] 创建数据目录:', alistDataDir);
    } catch (e) {
      console.warn('[AListManager] 创建数据目录失败:', e.message);
    }
  }

  // 检查 AList 二进制是否存在
  if (!fs.existsSync(_alistBin)) {
    console.warn('[AListManager] AList 二进制不存在:', _alistBin, '，跳过自动启动');
    return;
  }

  // 延迟启动，先检查是否已由容器 entrypoint 启动
  setTimeout(async () => {
    const alreadyRunning = await _isAlistRunning();
    if (alreadyRunning) {
      _externalAlist = true;
      console.log('[AListManager] 检测到 AList 已在运行（容器 entrypoint 启动），进入监控模式');
      return;
    }
    start().catch(e => console.warn('[AListManager] 启动失败:', e.message));
  }, 3000);
}

/**
 * 启动 AList 服务
 */
async function start() {
  if (_starting) {
    console.log('[AListManager] 已有启动任务在进行');
    return;
  }
  if (_alistProcess && !_alistProcess.killed) {
    console.log('[AListManager] AList 已在运行');
    return;
  }

  _starting = true;
  _stopping = false;

  try {
    // 优先使用 entrypoint 的数据目录和库路径
    const alistDataDir = process.env.ALIST_DATA_DIR || '/opt/alist/data';
    const ldLibPath = process.env.LD_LIBRARY_PATH || '/opt/alist/lib';

    // 确保数据目录存在
    if (!fs.existsSync(alistDataDir)) {
      try { fs.mkdirSync(alistDataDir, { recursive: true }); } catch (e) { /* ignore */ }
    }

    console.log('[AListManager] 启动 AList, 端口:', _alistPort, '数据目录:', alistDataDir);

    const env = {
      ...process.env,
      ALIST_PORT: String(_alistPort),
      LD_LIBRARY_PATH: ldLibPath,
    };

    _alistProcess = spawn(_alistBin, ['server', '--no-prefix', '--data', alistDataDir], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    _alistProcess.stdout.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) {
        // 过滤掉过于频繁的日志
        if (msg.includes('error') || msg.includes('failed') || msg.includes('started') || msg.includes('listening')) {
          console.log('[AList]', msg.substring(0, 200));
        }
      }
    });

    _alistProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) {
        console.warn('[AList-err]', msg.substring(0, 200));
      }
    });

    _alistProcess.on('exit', (code, signal) => {
      console.log(`[AListManager] 进程退出 code=${code} signal=${signal}`);
      _alistProcess = null;

      if (!_stopping && _restartCount < MAX_RESTARTS) {
        _restartCount++;
        console.log(`[AListManager] ${_restartCount}/${MAX_RESTARTS} 秒后重启...`);
        setTimeout(() => {
          if (!_stopping) {
            start().catch(e => console.warn('[AListManager] 重启失败:', e.message));
          }
        }, 5000);
      } else if (_restartCount >= MAX_RESTARTS) {
        console.error('[AListManager] 超过最大重启次数，停止重启');
      }
    });

    _alistProcess.on('error', (err) => {
      console.error('[AListManager] 进程错误:', err.message);
      _alistProcess = null;
    });

    // 等待 AList 就绪
    await _waitForReady(30000);
    _restartCount = 0;
    console.log('[AListManager] AList 启动成功，端口:', _alistPort);

    // 设置管理员密码
    await _setAdminPassword().catch(e => {
      console.warn('[AListManager] 设置密码失败（可能已设置过）:', e.message);
    });

  } finally {
    _starting = false;
  }
}

/**
 * 停止 AList 服务
 */
function stop() {
  _stopping = true;
  if (_alistProcess) {
    console.log('[AListManager] 停止 AList...');
    _alistProcess.kill('SIGTERM');
    setTimeout(() => {
      if (_alistProcess) {
        _alistProcess.kill('SIGKILL');
        _alistProcess = null;
      }
    }, 5000);
  }
}

/**
 * 获取 AList 状态
 */
function getStatus() {
  return {
    running: _externalAlist || (!!_alistProcess && !_alistProcess.killed),
    external: _externalAlist,
    port: _alistPort,
    bin: _alistBin,
    restartCount: _restartCount,
    pid: _alistProcess ? _alistProcess.pid : null,
  };
}

/**
 * 等待 AList HTTP 服务就绪
 */
function _waitForReady(timeout) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const req = http.get(`http://127.0.0.1:${_alistPort}/api/public/settings`, { timeout: 3000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve();
        } else {
          retry();
        }
      });
      req.on('error', () => retry());
      req.on('timeout', () => { req.destroy(); retry(); });
    };

    const retry = () => {
      if (Date.now() - start > timeout) {
        reject(new Error('AList 启动超时'));
        return;
      }
      setTimeout(check, 1000);
    };

    check();
  });
}

/**
 * 设置 AList 管理员密码
 * 通过 AList CLI 设置密码
 */
async function _setAdminPassword() {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    const alistDataDir = process.env.ALIST_DATA_DIR || '/opt/alist/data';
    const ldLibPath = process.env.LD_LIBRARY_PATH || '/opt/alist/lib';

    execFile(_alistBin, ['admin', 'set', _adminPassword, '--data', alistDataDir], {
      timeout: 10000,
      env: { ...process.env, LD_LIBRARY_PATH: ldLibPath },
    }, (error, stdout, stderr) => {
      if (error) {
        console.warn('[AListManager] CLI 设置密码输出:', stdout, stderr);
        resolve();
      } else {
        console.log('[AListManager] 管理员密码已设置');
        resolve();
      }
    });
  });
}

module.exports = { init, start, stop, getStatus };
