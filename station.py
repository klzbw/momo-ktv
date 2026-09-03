# -*- coding: utf-8 -*-
"""
station.py —— 墨墨爱K歌 AI 分离工作站（可视化控制面板）
==============================================================================
本地 Web 控制面板，浏览器打开后可：
  - 一键启动 / 停止 Worker
  - 滑块手动调节并发线程数（1~16，动态增减无需重启）
  - 实时监控每个线程：当前歌曲、分离/对齐进度、完成/失败统计
  - 实时滚动日志（可暂停/清屏/过滤）
  - GPU 显存、利用率、温度监控

用法:
  python station.py --port 8765 --server http://192.168.3.16:8083 --worker pc-51 --mode both --capability gpu --threads 2
  然后浏览器打开 http://localhost:8765

设计要点：
  - 不依赖 Flask 等第三方 Web 框架，纯标准库 http.server，零额外安装
  - Worker 线程复用 worker.py 的 MomoWorker（每首歌仍起独立子进程 sep_once/align_once，跑完即退释放显存）
  - 日志通过重定向 sys.stdout 同时写文件 + 内存环形缓冲区，前端轮询/SSE 实时获取
  - 线程增减通过 MomoWorker.stop_event 优雅退出：减线程时被撤的线程跑完当前歌曲即退出，不中断任务
"""
import argparse, os, sys, time, json, threading, subprocess, re, io
from collections import deque
from http.server import HTTPServer, BaseHTTPRequestHandler

# 让 worker.py 能被 import（同目录）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from worker import MomoWorker, load_config

# Windows GBK控制台强制UTF-8
if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')

# ============================================================================
# 日志收集器：重定向 stdout，同时写原始终端 + 日志文件 + 内存环形缓冲区
# ============================================================================
class LogCollector(io.TextIOBase):
    def __init__(self, log_dir, max_lines=3000):
        self.orig_stdout = sys.stdout
        self.max_lines = max_lines
        self.buffer = deque(maxlen=max_lines)
        self.lock = threading.Lock()
        self.line_id = 0
        self.log_path = os.path.join(log_dir, f'station_{time.strftime("%Y%m%d_%H%M%S")}.log')
        try:
            self.file = open(self.log_path, 'w', encoding='utf-8', buffering=1)
        except Exception:
            self.file = None

    def write(self, s):
        if not s:
            return
        # 写原始终端
        try:
            self.orig_stdout.write(s)
            self.orig_stdout.flush()
        except Exception:
            pass
        # 写文件
        if self.file:
            try:
                self.file.write(s)
            except Exception:
                pass
        # 按行存入内存缓冲区
        with self.lock:
            for line in s.split('\n'):
                if line.strip() or s.endswith('\n'):
                    self.line_id += 1
                    self.buffer.append((self.line_id, time.strftime('%H:%M:%S'), line))

    def flush(self):
        try: self.orig_stdout.flush()
        except Exception: pass
        if self.file:
            try: self.file.flush()
            except Exception: pass

    def get_since(self, since_id):
        """返回 since_id 之后的所有日志行 [(id, time, text), ...]"""
        with self.lock:
            return [(i, t, l) for i, t, l in self.buffer if i > since_id]

    def get_latest_id(self):
        with self.lock:
            return self.line_id


# ============================================================================
# GPU 监控：调用 nvidia-smi
# ============================================================================
_gpu_cache = {'data': None, 'time': 0}

def get_gpu_info():
    now = time.time()
    if _gpu_cache['data'] and now - _gpu_cache['time'] < 2:
        return _gpu_cache['data']
    try:
        r = subprocess.run(
            ['nvidia-smi', '--query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu',
             '--format=csv,noheader,nounits'],
            capture_output=True, text=True, timeout=5)
        if r.returncode == 0 and r.stdout.strip():
            parts = [p.strip() for p in r.stdout.strip().split(',')]
            if len(parts) >= 5:
                data = {
                    'name': parts[0],
                    'mem_total_mb': int(parts[1]),
                    'mem_used_mb': int(parts[2]),
                    'util_pct': int(parts[3]),
                    'temp_c': int(parts[4]),
                }
                _gpu_cache['data'] = data
                _gpu_cache['time'] = now
                return data
    except Exception:
        pass
    return None


# ============================================================================
# WorkerManager：管理多个 MomoWorker 线程，支持动态增减
# ============================================================================
class WorkerManager:
    def __init__(self, server, worker_name, mode, python_exe, capability, initial_threads=2):
        self.server = server
        self.worker_name = worker_name
        self.mode = mode
        self.python_exe = python_exe
        self.capability = capability
        self.initial_threads = initial_threads
        self.workers = []  # [(thread, MomoWorker)]
        self.lock = threading.Lock()
        self.running = False
        self.start_time = None

    def _make_worker(self, idx):
        return MomoWorker(self.server, self.worker_name, self.mode,
                          self.python_exe, self.capability)

    def start(self):
        with self.lock:
            if self.running:
                return
            self.running = True
            self.start_time = time.time()
            self.workers = []
            for i in range(self.initial_threads):
                w = self._make_worker(i)
                t = threading.Thread(target=w.loop, name=f'W{i+1}', daemon=True)
                t.start()
                self.workers.append((t, w))
                time.sleep(0.2)
        print(f'[Station] Worker 已启动，{self.initial_threads} 个线程')

    def stop(self):
        with self.lock:
            if not self.running:
                return
            self.running = False
            for t, w in self.workers:
                w.stop()
        # 等线程退出（不在锁里等）
        for t, w in self.workers:
            t.join(timeout=30)
        with self.lock:
            self.workers = []
        print('[Station] 所有 Worker 线程已停止')

    def set_threads(self, n):
        """动态调整线程数：增加时启动新线程，减少时优雅停止多余线程"""
        n = max(1, min(16, int(n)))
        with self.lock:
            if not self.running:
                self.initial_threads = n
                return n, '未运行，已保存为启动时线程数'
            cur = len(self.workers)
            if n == cur:
                return n, '线程数不变'
            if n > cur:
                # 增加线程
                for i in range(cur, n):
                    w = self._make_worker(i)
                    t = threading.Thread(target=w.loop, name=f'W{i+1}', daemon=True)
                    t.start()
                    self.workers.append((t, w))
                    time.sleep(0.2)
                msg = f'已增加到 {n} 个线程'
            else:
                # 减少线程：从后往前停，被停的线程跑完当前任务即退出
                to_stop = self.workers[n:]
                self.workers = self.workers[:n]
                for t, w in to_stop:
                    w.stop()
                # 重命名剩余线程（保持 W1~Wn 连续）
                for idx, (t, w) in enumerate(self.workers):
                    try: t.name = f'W{idx+1}'
                    except Exception: pass
                msg = f'已减少到 {n} 个线程（被撤线程跑完当前歌曲后退出）'
            return n, msg

    def get_status(self):
        with self.lock:
            threads = []
            active = 0
            total_done = 0
            total_fail = 0
            for idx, (t, w) in enumerate(self.workers):
                job = w.current_job
                is_active = job is not None
                if is_active:
                    active += 1
                total_done += w.done_count
                total_fail += w.fail_count
                elapsed = None
                if job and job.get('start'):
                    elapsed = int(time.time() - job['start'])
                threads.append({
                    'name': t.name,
                    'alive': t.is_alive(),
                    'active': is_active,
                    'job': job,
                    'elapsed': elapsed,
                    'done': w.done_count,
                    'fail': w.fail_count,
                    'last_error': w.last_error,
                })
            return {
                'running': self.running,
                'thread_count': len(self.workers),
                'active_count': active,
                'total_done': total_done,
                'total_fail': total_fail,
                'uptime': int(time.time() - self.start_time) if self.start_time else 0,
                'threads': threads,
            }


# ============================================================================
# 全局单例
# ============================================================================
manager = None
log_collector = None


# ============================================================================
# HTTP 请求处理器
# ============================================================================
class StationHandler(BaseHTTPRequestHandler):
    def _send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, html):
        body = html.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/' or path == '/index.html':
            self._send_html(INDEX_HTML)
        elif path == '/api/status':
            status = manager.get_status()
            status['gpu'] = get_gpu_info()
            status['server'] = manager.server
            status['worker_name'] = manager.worker_name
            status['mode'] = manager.mode
            status['capability'] = manager.capability
            status['log_file'] = log_collector.log_path if log_collector else ''
            self._send_json(status)
        elif path == '/api/logs':
            since = 0
            qs = self.path.split('?')[1] if '?' in self.path else ''
            for kv in qs.split('&'):
                if kv.startswith('since='):
                    try: since = int(kv[6:])
                    except: pass
            lines = log_collector.get_since(since) if log_collector else []
            self._send_json({'lines': lines, 'latest_id': log_collector.get_latest_id() if log_collector else 0})
        elif path == '/api/gpu':
            self._send_json({'gpu': get_gpu_info()})
        else:
            self._send_json({'error': 'not found'}, 404)

    def do_POST(self):
        path = self.path.split('?')[0]
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length).decode('utf-8') if length else '{}'
        try:
            data = json.loads(body) if body else {}
        except Exception:
            data = {}

        if path == '/api/start':
            manager.start()
            self._send_json({'ok': True, 'msg': '已启动'})
        elif path == '/api/stop':
            manager.stop()
            self._send_json({'ok': True, 'msg': '已停止'})
        elif path == '/api/threads':
            n = int(data.get('threads', 2))
            count, msg = manager.set_threads(n)
            self._send_json({'ok': True, 'threads': count, 'msg': msg})
        else:
            self._send_json({'error': 'not found'}, 404)

    def log_message(self, *args):
        pass  # 静默 HTTP 请求日志，避免刷屏


# ============================================================================
# 前端 HTML（深色科技风，实时更新）
# ============================================================================
INDEX_HTML = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>墨墨爱K歌 · AI 分离工作站</title>
<style>
:root{
  --bg:#0a0e1a;--bg2:#111827;--card:#1a2236;--card2:#222d45;
  --border:#2d3a52;--text:#e2e8f0;--muted:#8892a8;--accent:#38bdf8;
  --accent2:#818cf8;--green:#34d399;--red:#f87171;--orange:#fb923c;
  --purple:#c084fc;
}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden}
body::before{content:'';position:fixed;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,var(--accent),var(--accent2),var(--purple));z-index:100}

/* 顶部导航 */
.topbar{display:flex;align-items:center;justify-content:space-between;padding:16px 28px;background:linear-gradient(180deg,rgba(26,34,54,.95),rgba(17,24,39,.8));backdrop-filter:blur(12px);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:50}
.brand{display:flex;align-items:center;gap:14px}
.logo{width:42px;height:42px;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;font-size:22px;box-shadow:0 0 24px rgba(56,189,248,.4)}
.brand h1{font-size:18px;font-weight:700;background:linear-gradient(90deg,var(--accent),var(--accent2));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.brand .sub{font-size:11px;color:var(--muted);margin-top:2px}
.top-right{display:flex;align-items:center;gap:16px}
.status-pill{display:flex;align-items:center;gap:8px;padding:6px 14px;border-radius:20px;background:var(--card);border:1px solid var(--border);font-size:13px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--muted);transition:.3s}
.dot.on{background:var(--green);box-shadow:0 0 10px var(--green);animation:pulse 2s infinite}
.dot.off{background:var(--red)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.btn{padding:9px 22px;border-radius:10px;border:none;cursor:pointer;font-size:14px;font-weight:600;transition:.2s;display:inline-flex;align-items:center;gap:8px}
.btn-start{background:linear-gradient(135deg,var(--green),#059669);color:#fff;box-shadow:0 4px 16px rgba(52,211,153,.3)}
.btn-start:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(52,211,153,.45)}
.btn-stop{background:linear-gradient(135deg,var(--red),#dc2626);color:#fff;box-shadow:0 4px 16px rgba(248,113,113,.3)}
.btn-stop:hover{transform:translateY(-1px)}
.btn:disabled{opacity:.4;cursor:not-allowed;transform:none}

/* 主内容 */
.main{max-width:1400px;margin:0 auto;padding:24px 28px 60px}
.section-title{font-size:14px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin:24px 0 12px;display:flex;align-items:center;gap:8px}
.section-title::before{content:'';width:3px;height:14px;background:var(--accent);border-radius:2px}

/* 统计卡片 */
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.stat-card{background:linear-gradient(135deg,var(--card),var(--card2));border:1px solid var(--border);border-radius:16px;padding:20px 22px;position:relative;overflow:hidden;transition:.3s}
.stat-card:hover{transform:translateY(-2px);border-color:var(--accent)}
.stat-card::after{content:'';position:absolute;top:0;right:0;width:80px;height:80px;border-radius:50%;filter:blur(40px);opacity:.3}
.stat-card:nth-child(1)::after{background:var(--accent)}
.stat-card:nth-child(2)::after{background:var(--orange)}
.stat-card:nth-child(3)::after{background:var(--green)}
.stat-card:nth-child(4)::after{background:var(--red)}
.stat-label{font-size:12px;color:var(--muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px}
.stat-value{font-size:32px;font-weight:800;line-height:1}
.stat-value .unit{font-size:14px;color:var(--muted);font-weight:400;margin-left:4px}
.stat-sub{font-size:11px;color:var(--muted);margin-top:8px}

/* 控制面板 */
.panel{background:linear-gradient(135deg,var(--card),var(--card2));border:1px solid var(--border);border-radius:16px;padding:22px}
.control-row{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.ctrl-group{margin-bottom:16px}
.ctrl-label{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.ctrl-label span{font-size:13px;color:var(--muted)}
.ctrl-label .val{font-size:20px;font-weight:700;color:var(--accent)}
input[type=range]{width:100%;height:6px;-webkit-appearance:none;background:var(--bg2);border-radius:3px;outline:none}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2));cursor:pointer;box-shadow:0 0 12px rgba(56,189,248,.5);border:2px solid #fff}
.quick-btns{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
.quick-btn{padding:6px 14px;border-radius:8px;background:var(--bg2);border:1px solid var(--border);color:var(--text);cursor:pointer;font-size:12px;transition:.2s}
.quick-btn:hover{border-color:var(--accent);color:var(--accent)}
.quick-btn.active{background:var(--accent);color:#000;border-color:var(--accent);font-weight:600}
.btn-apply{width:100%;padding:12px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#000;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;transition:.2s;margin-top:8px}
.btn-apply:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(56,189,248,.4)}
.btn-apply:disabled{opacity:.4;cursor:not-allowed}

/* GPU 卡片 */
.gpu-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
.gpu-item{background:var(--bg2);border-radius:10px;padding:12px 14px}
.gpu-item .lbl{font-size:11px;color:var(--muted);margin-bottom:4px}
.gpu-item .v{font-size:18px;font-weight:700}
.mem-bar{height:8px;background:var(--bg);border-radius:4px;overflow:hidden;margin-top:8px}
.mem-fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:4px;transition:width .5s}
.gpu-name{font-size:12px;color:var(--muted);margin-bottom:12px;padding:8px 12px;background:var(--bg2);border-radius:8px;text-align:center}

/* 线程列表 */
.thread-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px}
.thread-card{background:linear-gradient(135deg,var(--card),var(--card2));border:1px solid var(--border);border-radius:14px;padding:16px 18px;transition:.3s;position:relative}
.thread-card.active{border-color:var(--accent);box-shadow:0 0 20px rgba(56,189,248,.15)}
.thread-card.idle{opacity:.7}
.thread-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.thread-name{font-size:15px;font-weight:700;display:flex;align-items:center;gap:8px}
.thread-name .idx{width:26px;height:26px;border-radius:8px;background:var(--bg2);display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--accent)}
.badge{padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600}
.badge.run{background:rgba(52,211,153,.15);color:var(--green)}
.badge.idle{background:rgba(136,146,168,.15);color:var(--muted)}
.badge.err{background:rgba(248,113,113,.15);color:var(--red)}
.job-info{font-size:13px;margin-bottom:6px;line-height:1.5}
.job-info .title{color:var(--text);font-weight:600}
.job-info .artist{color:var(--muted);font-size:12px}
.job-type{display:inline-block;padding:2px 8px;border-radius:6px;font-size:10px;font-weight:600;margin-right:6px}
.job-type.sep{background:rgba(56,189,248,.15);color:var(--accent)}
.job-type.align{background:rgba(192,132,252,.15);color:var(--purple)}
.progress-wrap{margin:10px 0}
.progress-bar{height:6px;background:var(--bg);border-radius:3px;overflow:hidden}
.progress-fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:3px;transition:width .4s}
.progress-text{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:5px}
.thread-stats{display:flex;gap:14px;margin-top:10px;padding-top:10px;border-top:1px solid var(--border);font-size:12px}
.thread-stats span{color:var(--muted)}
.thread-stats b{color:var(--text)}
.err-msg{font-size:11px;color:var(--red);margin-top:6px;padding:6px 10px;background:rgba(248,113,113,.08);border-radius:6px;word-break:break-all}

/* 日志面板 */
.log-panel{background:var(--card);border:1px solid var(--border);border-radius:16px;overflow:hidden}
.log-head{display:flex;justify-content:space-between;align-items:center;padding:12px 18px;background:var(--bg2);border-bottom:1px solid var(--border)}
.log-head .title{font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px}
.log-head .title .live{width:7px;height:7px;border-radius:50%;background:var(--green);animation:pulse 1.5s infinite}
.log-controls{display:flex;gap:8px;align-items:center}
.log-btn{padding:5px 12px;border-radius:7px;background:var(--card);border:1px solid var(--border);color:var(--muted);cursor:pointer;font-size:12px;transition:.2s}
.log-btn:hover{color:var(--text);border-color:var(--accent)}
.log-btn.active{color:var(--accent);border-color:var(--accent)}
.log-body{height:320px;overflow-y:auto;padding:12px 18px;font-family:'Consolas','Courier New',monospace;font-size:12px;line-height:1.7;background:#0d1117}
.log-line{white-space:pre-wrap;word-break:break-all}
.log-line .t{color:#6e7681;margin-right:8px}
.log-line .tn{color:#38bdf8;margin-right:6px;font-weight:600}
.log-line.err{color:#f87171}
.log-line.warn{color:#fb923c}
.log-line.info{color:#8892a8}
.log-body::-webkit-scrollbar{width:6px}
.log-body::-webkit-scrollbar-track{background:transparent}
.log-body::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}

/* 空状态 */
.empty{text-align:center;padding:40px 20px;color:var(--muted);font-size:14px}
.empty .icon{font-size:48px;margin-bottom:12px;opacity:.4}

/* 响应式 */
@media(max-width:900px){
  .stats{grid-template-columns:repeat(2,1fr)}
  .control-row{grid-template-columns:1fr}
  .topbar{flex-direction:column;gap:12px}
}
</style>
</head>
<body>

<div class="topbar">
  <div class="brand">
    <div class="logo">🎵</div>
    <div>
      <h1>墨墨爱K歌 · AI 分离工作站</h1>
      <div class="sub" id="serverInfo">加载中...</div>
    </div>
  </div>
  <div class="top-right">
    <div class="status-pill">
      <div class="dot" id="statusDot"></div>
      <span id="statusText">未运行</span>
    </div>
    <button class="btn btn-start" id="btnStart" onclick="startWorker()">▶ 启动 Worker</button>
    <button class="btn btn-stop" id="btnStop" onclick="stopWorker()" style="display:none">■ 停止 Worker</button>
  </div>
</div>

<div class="main">
  <!-- 统计卡片 -->
  <div class="stats">
    <div class="stat-card">
      <div class="stat-label">工作线程</div>
      <div class="stat-value" id="statThreads">0<span class="unit">个</span></div>
      <div class="stat-sub" id="statActive">0 个活跃</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">运行时长</div>
      <div class="stat-value" id="statUptime">0<span class="unit">分</span></div>
      <div class="stat-sub">本次启动后</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">完成任务</div>
      <div class="stat-value" id="statDone" style="color:var(--green)">0<span class="unit">首</span></div>
      <div class="stat-sub">分离 + 对齐合计</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">失败任务</div>
      <div class="stat-value" id="statFail" style="color:var(--red)">0<span class="unit">首</span></div>
      <div class="stat-sub">自动重试不影响</div>
    </div>
  </div>

  <!-- 控制面板 + GPU -->
  <div class="section-title">线程控制 & GPU 监控</div>
  <div class="control-row">
    <div class="panel">
      <div class="ctrl-group">
        <div class="ctrl-label">
          <span>并发线程数（动态调节，无需重启）</span>
          <span class="val" id="threadVal">2</span>
        </div>
        <input type="range" id="threadSlider" min="1" max="16" value="2" oninput="document.getElementById('threadVal').textContent=this.value">
        <div class="quick-btns">
          <button class="quick-btn" onclick="setQuick(1)">1</button>
          <button class="quick-btn active" onclick="setQuick(2)">2</button>
          <button class="quick-btn" onclick="setQuick(4)">4</button>
          <button class="quick-btn" onclick="setQuick(6)">6</button>
          <button class="quick-btn" onclick="setQuick(8)">8</button>
          <button class="quick-btn" onclick="setQuick(12)">12</button>
          <button class="quick-btn" onclick="setQuick(16)">16</button>
        </div>
      </div>
      <button class="btn-apply" id="btnApply" onclick="applyThreads()">应用线程数</button>
      <div style="font-size:11px;color:var(--muted);margin-top:10px;line-height:1.6">
        💡 GPU 模式建议 2~3 线程（4070TiS 16G 可跑 3~4）；减少线程时被撤线程会跑完当前歌曲后退出，不中断任务。
      </div>
    </div>
    <div class="panel" id="gpuPanel">
      <div class="gpu-name" id="gpuName">未检测到 NVIDIA GPU</div>
      <div class="gpu-grid">
        <div class="gpu-item">
          <div class="lbl">显存使用</div>
          <div class="v" id="gpuMem">-- / -- MB</div>
          <div class="mem-bar"><div class="mem-fill" id="gpuMemBar" style="width:0%"></div></div>
        </div>
        <div class="gpu-item">
          <div class="lbl">GPU 利用率</div>
          <div class="v" id="gpuUtil">-- %</div>
          <div class="mem-bar"><div class="mem-fill" id="gpuUtilBar" style="width:0%;background:linear-gradient(90deg,var(--orange),var(--red))"></div></div>
        </div>
        <div class="gpu-item">
          <div class="lbl">温度</div>
          <div class="v" id="gpuTemp">-- °C</div>
        </div>
        <div class="gpu-item">
          <div class="lbl">算力模式</div>
          <div class="v" id="gpuCap" style="font-size:14px">--</div>
        </div>
      </div>
    </div>
  </div>

  <!-- 线程列表 -->
  <div class="section-title">线程状态</div>
  <div class="thread-grid" id="threadGrid">
    <div class="empty"><div class="icon">⚙️</div>Worker 未启动，点击右上角「启动 Worker」</div>
  </div>

  <!-- 日志 -->
  <div class="section-title">实时日志</div>
  <div class="log-panel">
    <div class="log-head">
      <div class="title"><div class="live"></div>运行日志 <span style="color:var(--muted);font-weight:400;font-size:11px" id="logFile"></span></div>
      <div class="log-controls">
        <button class="log-btn active" id="btnAutoScroll" onclick="toggleAutoScroll()">自动滚动</button>
        <button class="log-btn" id="btnPauseLog" onclick="togglePauseLog()">暂停</button>
        <button class="log-btn" onclick="clearLog()">清屏</button>
      </div>
    </div>
    <div class="log-body" id="logBody"></div>
  </div>
</div>

<script>
let running=false;
let logSince=0;
let autoScroll=true;
let pauseLog=false;
let currentThreads=2;

function fmtTime(sec){
  if(sec<60)return sec+'秒';
  if(sec<3600)return Math.floor(sec/60)+'分';
  return Math.floor(sec/3600)+'时'+Math.floor((sec%3600)/60)+'分';
}

async function fetchStatus(){
  try{
    const r=await fetch('/api/status');
    const d=await r.json();
    running=d.running;
    // 顶部状态
    const dot=document.getElementById('statusDot');
    const st=document.getElementById('statusText');
    if(running){dot.className='dot on';st.textContent='运行中';}
    else{dot.className='dot off';st.textContent='已停止';}
    document.getElementById('btnStart').style.display=running?'none':'inline-flex';
    document.getElementById('btnStop').style.display=running?'inline-flex':'none';
    document.getElementById('serverInfo').textContent=`${d.server} · ${d.worker_name} · ${d.mode} · ${d.capability}`;
    // 统计
    document.getElementById('statThreads').innerHTML=`${d.thread_count}<span class="unit">个</span>`;
    document.getElementById('statActive').textContent=`${d.active_count} 个活跃`;
    document.getElementById('statUptime').innerHTML=`${fmtTime(d.uptime)}`;
    document.getElementById('statDone').innerHTML=`${d.total_done}<span class="unit">首</span>`;
    document.getElementById('statFail').innerHTML=`${d.total_fail}<span class="unit">首</span>`;
    // GPU
    if(d.gpu){
      document.getElementById('gpuName').textContent=d.gpu.name;
      document.getElementById('gpuMem').textContent=`${d.gpu.mem_used_mb} / ${d.gpu.mem_total_mb} MB`;
      document.getElementById('gpuMemBar').style.width=(d.gpu.mem_used_mb/d.gpu.mem_total_mb*100)+'%';
      document.getElementById('gpuUtil').textContent=d.gpu.util_pct+' %';
      document.getElementById('gpuUtilBar').style.width=d.gpu.util_pct+'%';
      document.getElementById('gpuTemp').textContent=d.gpu.temp_c+' °C';
      document.getElementById('gpuCap').textContent=d.capability.toUpperCase();
    }
    // 线程列表
    const grid=document.getElementById('threadGrid');
    if(!d.threads||d.threads.length===0){
      grid.innerHTML='<div class="empty"><div class="icon">⚙️</div>Worker 未启动，点击右上角「启动 Worker」</div>';
    }else{
      grid.innerHTML=d.threads.map((t,i)=>{
        const active=t.active&&t.job;
        const cls=active?'active':'idle';
        const badge=active?'<span class="badge run">运行中</span>':'<span class="badge idle">空闲</span>';
        let jobHtml='';
        if(active&&t.job){
          const jp=t.job.progress||0;
          const jt=t.job.type==='separate'?'<span class="job-type sep">人声分离</span>':'<span class="job-type align">逐字对齐</span>';
          jobHtml=`
            <div class="job-info">${jt}<span class="title">${esc(t.job.title||'未知')}</span></div>
            <div class="job-info artist">${esc(t.job.artist||'')} · #${t.job.id}</div>
            <div class="progress-wrap">
              <div class="progress-bar"><div class="progress-fill" style="width:${jp}%"></div></div>
              <div class="progress-text"><span>进度 ${jp}%</span><span>已用 ${t.elapsed||0}秒</span></div>
            </div>`;
        }else{
          jobHtml='<div class="job-info" style="color:var(--muted)">等待任务...</div>';
        }
        const err=t.last_error?`<div class="err-msg">⚠ ${esc(t.last_error)}</div>`:'';
        return `<div class="thread-card ${cls}">
          <div class="thread-head">
            <div class="thread-name"><span class="idx">${i+1}</span>${t.name}</div>
            ${badge}
          </div>
          ${jobHtml}
          <div class="thread-stats">
            <span>完成 <b>${t.done}</b></span>
            <span>失败 <b>${t.fail}</b></span>
            <span>状态 <b>${t.alive?'存活':'已退出'}</b></span>
          </div>
          ${err}
        </div>`;
      }).join('');
    }
    if(d.log_file)document.getElementById('logFile').textContent='· '+d.log_file.split('\\').pop();
  }catch(e){console.error(e)}
}

function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

async function fetchLogs(){
  if(pauseLog)return;
  try{
    const r=await fetch('/api/logs?since='+logSince);
    const d=await r.json();
    if(d.lines&&d.lines.length>0){
      const body=document.getElementById('logBody');
      const frag=document.createDocumentFragment();
      d.lines.forEach(([id,tm,txt])=>{
        if(!txt.trim())return;
        const div=document.createElement('div');
        div.className='log-line';
        if(/error|traceback|失败|exception/i.test(txt))div.className+=' err';
        else if(/warn|警告/i.test(txt))div.className+=' warn';
        const m=txt.match(/^\[(\w+)\]\s?(.*)/);
        if(m){
          div.innerHTML=`<span class="t">${tm}</span><span class="tn">[${m[1]}]</span>${esc(m[2])}`;
        }else{
          div.innerHTML=`<span class="t">${tm}</span>${esc(txt)}`;
        }
        frag.appendChild(div);
        logSince=id;
      });
      body.appendChild(frag);
      if(autoScroll)body.scrollTop=body.scrollHeight;
      // 限制最大行数
      while(body.children.length>1500)body.removeChild(body.firstChild);
    }
  }catch(e){}
}

async function startWorker(){
  await fetch('/api/start',{method:'POST'});
  fetchStatus();
}
async function stopWorker(){
  if(!confirm('确定停止 Worker？正在处理的任务会跑完后退出。'))return;
  await fetch('/api/stop',{method:'POST'});
  fetchStatus();
}
async function applyThreads(){
  const n=parseInt(document.getElementById('threadSlider').value);
  const r=await fetch('/api/threads',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({threads:n})});
  const d=await r.json();
  currentThreads=d.threads;
  fetchStatus();
}
function setQuick(n){
  document.getElementById('threadSlider').value=n;
  document.getElementById('threadVal').textContent=n;
  document.querySelectorAll('.quick-btn').forEach(b=>b.classList.remove('active'));
  event.target.classList.add('active');
}
function toggleAutoScroll(){
  autoScroll=!autoScroll;
  document.getElementById('btnAutoScroll').classList.toggle('active',autoScroll);
}
function togglePauseLog(){
  pauseLog=!pauseLog;
  document.getElementById('btnPauseLog').classList.toggle('active',pauseLog);
  document.getElementById('btnPauseLog').textContent=pauseLog?'继续':'暂停';
}
function clearLog(){document.getElementById('logBody').innerHTML='';}

// 启动轮询
fetchStatus();
setInterval(fetchStatus,1500);
setInterval(fetchLogs,800);
</script>
</body>
</html>
"""


# ============================================================================
# main
# ============================================================================
def main():
    global manager, log_collector

    cfg = load_config()

    ap = argparse.ArgumentParser(description='墨墨爱K歌 AI 分离工作站（可视化控制面板）')
    ap.add_argument('--port', type=int, default=cfg.get('station_port', 8765), help='Web 控制面板端口（默认8765）')
    ap.add_argument('--host', default='0.0.0.0', help='监听地址（默认0.0.0.0，局域网可访问）')
    ap.add_argument('--server', default=cfg.get('server_url', os.environ.get('MOMO_SERVER', 'http://192.168.3.16:8083')))
    ap.add_argument('--worker', default=cfg.get('worker_name', os.environ.get('MOMO_WORKER', 'pc-gpu')))
    ap.add_argument('--mode', default=cfg.get('mode', 'both'), choices=['separate', 'align', 'both'])
    ap.add_argument('--python', default=cfg.get('python_exe', ''), help='子进程用的 python')
    ap.add_argument('--capability', default=cfg.get('capability', os.environ.get('MOMO_CAPABILITY', '')),
                    choices=['', 'gpu', 'cpu'])
    ap.add_argument('--threads', type=int, default=cfg.get('threads', 0),
                    help='启动时线程数（0=自动：GPU默认2，CPU默认4）')
    ap.add_argument('--autostart', action='store_true', help='启动控制面板时自动启动 Worker')
    a = ap.parse_args()

    # 配置透传给子进程
    if cfg.get('device'): os.environ['MOMO_DEVICE'] = cfg['device']
    if cfg.get('demucs_model'): os.environ['MOMO_DEMUCS_MODEL'] = cfg['demucs_model']
    if cfg.get('whisper_model'): os.environ['MOMO_WHISPER_MODEL'] = cfg['whisper_model']
    if cfg.get('batch_size'): os.environ['MOMO_BATCH_SIZE'] = str(cfg['batch_size'])

    cap = (a.capability or '').lower()
    if not cap:
        # 自动探测 GPU
        try:
            import torch
            cap = 'gpu' if torch.cuda.is_available() else 'cpu'
        except Exception:
            cap = 'cpu'
    init_threads = a.threads if a.threads and a.threads > 0 else (2 if cap == 'gpu' else 4)

    # 日志收集器（重定向 stdout）
    log_dir = os.path.dirname(os.path.abspath(__file__))
    log_collector = LogCollector(log_dir)
    sys.stdout = log_collector
    sys.stderr = log_collector

    # WorkerManager
    manager = WorkerManager(a.server, a.worker, a.mode, a.python or sys.executable, cap, init_threads)

    print(f'=' * 60)
    print(f'墨墨爱K歌 · AI 分离工作站 启动')
    print(f'=' * 60)
    print(f'服务端: {a.server}')
    print(f'Worker名: {a.worker}')
    print(f'模式: {a.mode}')
    print(f'算力: {cap}')
    print(f'初始线程: {init_threads}')
    print(f'日志文件: {log_collector.log_path}')
    print(f'=' * 60)

    if a.autostart:
        manager.start()

    # 启动 HTTP 服务器
    server = HTTPServer((a.host, a.port), StationHandler)
    print(f'Web 控制面板已启动: http://localhost:{a.port}')
    print(f'局域网访问: http://<本机IP>:{a.port}')
    print(f'按 Ctrl+C 退出')
    print(f'=' * 60)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n收到退出信号，正在停止...')
        manager.stop()
        server.shutdown()
        print('工作站已退出')


if __name__ == '__main__':
    main()
