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
import requests
import urllib.parse
from collections import deque
from http.server import HTTPServer, ThreadingHTTPServer, BaseHTTPRequestHandler

# 让 worker.py 能被 import（同目录）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from worker import MomoWorker, load_config, DEMUCS_ENGINE, WHISPER_ENGINE

# Windows GBK控制台强制UTF-8
if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')
# 确保 ffmpeg 在 PATH 中（whisperx.load_audio 内部调用 ffmpeg，SYSTEM 身份运行时 PATH 可能不含）
_ffmpeg_dir = r'C:\ffmpeg\bin'
if os.path.isdir(_ffmpeg_dir) and _ffmpeg_dir not in os.environ.get('PATH', ''):
    os.environ['PATH'] = _ffmpeg_dir + os.pathsep + os.environ.get('PATH', '')

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
        # GPU 模式上限 3（16GB 显存跑 WhisperX large-v3 + Demucs，超过 3 必 OOM）
        cap = (self.capability or '').lower()
        max_threads = 3 if cap == 'gpu' else 8
        n = max(1, min(max_threads, int(n)))
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
# ConvertManager —— FLAC 音频转码管理（调用 flac_convert.py 子进程）
# ============================================================================
class ConvertManager:
    """管理 flac_convert.py 转码子进程，支持启动/停止、实时日志、进度解析。
    转码脚本本身用 ProcessPoolExecutor 多进程并发，这里只负责拉起和监控。
    """
    def __init__(self, python_exe, script_dir):
        self.py = python_exe
        self.script_dir = script_dir
        self.process = None
        self.running = False
        self.config = {
            'root': r'\\192.168.3.80\music',
            'out_root': '',
            'mode': 'cue',
            'workers': 8,
            'only': '',
            'limit': 0,
            'dry': False,
            'smb_share': r'\\192.168.3.80\music',
            'smb_user': '',
            'smb_pass': '',
        }
        self.stats = {'total': 0, 'done': 0, 'ok': 0, 'skip': 0, 'fail': 0, 'elapsed': 0, 'current': '', 'total_tracks': 0}
        self.log_buffer = deque(maxlen=3000)
        self.log_lock = threading.Lock()
        self.log_id = 0
        self.start_time = None

    def start(self, config=None):
        if self.running:
            return False, '转码已在运行中，请先停止'
        if config:
            self.config.update({k: v for k, v in config.items() if v is not None})
        c = self.config
        cmd = [self.py, os.path.join(self.script_dir, 'flac_convert.py'),
               '--root', c['root'],
               '--mode', c['mode'],
               '--workers', str(c['workers'])]
        if c.get('out_root'):
            cmd += ['--out-root', c['out_root']]
        if c.get('only'):
            cmd += ['--only', c['only']]
        if c.get('limit', 0) and int(c['limit']) > 0:
            cmd += ['--limit', str(c['limit'])]
        if c.get('dry'):
            cmd += ['--dry']
        if c.get('smb_share'):
            cmd += ['--smb-share', c['smb_share']]
        if c.get('smb_user'):
            cmd += ['--smb-user', c['smb_user']]
        if c.get('smb_pass'):
            cmd += ['--smb-pass', c['smb_pass']]

        print(f'[Convert] 启动转码: mode={c["mode"]} workers={c["workers"]} root={c["root"]}')
        try:
            self.process = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding='utf-8', errors='replace', bufsize=1)
        except Exception as e:
            return False, f'启动失败: {e}'
        self.running = True
        self.start_time = time.time()
        self.stats = {'total': 0, 'done': 0, 'ok': 0, 'skip': 0, 'fail': 0, 'elapsed': 0, 'current': '', 'total_tracks': 0}
        threading.Thread(target=self._read_logs, daemon=True).start()
        return True, '转码已启动'

    def stop(self):
        if not self.running or not self.process:
            return False, '转码未运行'
        print('[Convert] 停止转码（杀进程树）...')
        pid = self.process.pid
        try:
            subprocess.run(['taskkill', '/PID', str(pid), '/T', '/F'], capture_output=True, timeout=20)
        except Exception:
            pass
        try:
            self.process.terminate()
            self.process.wait(timeout=10)
        except Exception:
            try: self.process.kill()
            except Exception: pass
        self.running = False
        self._append_log('[Convert] 转码已手动停止（进程树已清理）')
        return True, '转码已停止'

    def _read_logs(self):
        """后台线程：读取子进程 stdout，解析进度，写入日志缓冲区。"""
        try:
            for line in self.process.stdout:
                line = line.rstrip()
                if not line:
                    continue
                self._append_log(line)
                # 解析进度行: "进度 20/100 ok=15 skip=3 fail=2 用时60s 专辑名"
                m = re.search(r'进度\s+(\d+)/(\d+)\s+ok=(\d+)\s+skip=(\d+)\s+fail=(\d+)\s+用时([\d.]+)s\s*(.*)', line)
                if m:
                    self.stats['done'] = int(m.group(1))
                    self.stats['total'] = int(m.group(2))
                    self.stats['ok'] = int(m.group(3))
                    self.stats['skip'] = int(m.group(4))
                    self.stats['fail'] = int(m.group(5))
                    self.stats['elapsed'] = float(m.group(6))
                    self.stats['current'] = m.group(7)
                # 解析完成行: "全部完成: ok=100 skip=5 fail=2 总用时5.0分钟"
                m2 = re.search(r'全部完成:\s+ok=(\d+)\s+skip=(\d+)\s+fail=(\d+)\s+总用时([\d.]+)分钟', line)
                if m2:
                    self.stats['ok'] = int(m2.group(1))
                    self.stats['skip'] = int(m2.group(2))
                    self.stats['fail'] = int(m2.group(3))
                    self.running = False
                # 解析总数行: "整轨目录数= 100" / "单曲文件数= 500"
                m3 = re.search(r'(整轨目录数|单曲文件数)=\s*(\d+)', line)
                if m3:
                    self.stats['total_tracks'] = int(m3.group(2))
        except Exception as e:
            self._append_log(f'[Convert] 日志读取异常: {e}')
        finally:
            if self.process:
                self.process.wait()
            self.running = False

    def _append_log(self, line):
        with self.log_lock:
            self.log_id += 1
            self.log_buffer.append((self.log_id, time.strftime('%H:%M:%S'), line))

    def get_logs(self, since=0):
        with self.log_lock:
            return [(i, t, l) for i, t, l in self.log_buffer if i > since]

    def get_status(self):
        elapsed = int(time.time() - self.start_time) if (self.start_time and self.running) else int(self.stats.get('elapsed', 0))
        progress = 0
        if self.stats['total'] > 0:
            progress = int(self.stats['done'] / self.stats['total'] * 100)
        return {
            'running': self.running,
            'config': self.config,
            'stats': {**self.stats, 'elapsed': elapsed, 'progress': progress},
            'log_count': self.log_id,
        }


# ============================================================================
# ManualTaskManager —— 自定义文件手动处理（不经数据库，本机直接调引擎）
# ============================================================================
class ManualTaskManager:
    """管理"自定义文件处理"后台线程：直接调 DEMUCS_ENGINE / WHISPER_ENGINE。
    与自动模式共用 GPU（引擎内部已有锁串行化），产物保存到用户指定目录。"""
    def __init__(self):
        self.thread = None
        self.running = False
        self.stop_event = threading.Event()
        self.start_time = None
        self.stats = {
            'output_dir': '', 'task': '',
            'current_step': '', 'progress': 0,
            'current_file': '', 'total_files': 0, 'done_files': 0,
            'output_files': [], 'error': '',
        }

    def start(self, input_paths_text, output_dir, task='both', upload_back=False):
        if self.running:
            return False, '手动处理已在运行中，请先停止'
        self.stop_event.clear()
        # 拆分多文件：换行或逗号分隔
        paths = [p.strip() for p in re.split(r'[\n,，]+', input_paths_text) if p.strip()]
        if not paths:
            return False, '未解析到任何文件路径'
        self.stats = {
            'output_dir': output_dir, 'task': task,
            'current_step': '排队中', 'progress': 0,
            'current_file': '', 'total_files': len(paths), 'done_files': 0,
            'output_files': [], 'error': '',
        }
        self.running = True
        self.start_time = time.time()
        self.thread = threading.Thread(
            target=self._run, args=(paths, output_dir, task, upload_back),
            name='ManualProc', daemon=True)
        self.thread.start()
        return True, f'已受理 {len(paths)} 个文件，后台处理中（日志见下方实时日志面板）'

    def stop(self):
        if not self.running:
            return False, '没有正在运行的手动任务'
        self.stop_event.set()
        print('[Manual] 收到停止请求，当前推理步骤完成后退出...', flush=True)
        return True, '停止请求已发送（当前推理步骤完成后停止）'

    def get_status(self):
        s = {'running': self.running, **self.stats}
        s['elapsed'] = int(time.time() - self.start_time) if (self.start_time and self.running) else 0
        return s

    def _run_one(self, src, output_dir, stem, task, upload_back, file_idx, total):
        """处理单个文件，返回该文件产生的输出文件列表。"""
        output_files = []
        # 人声分离
        need_sep = task in ('separate', 'both')
        vocals_path = os.path.join(output_dir, f'{stem}-vocals.wav')
        accomp_path = os.path.join(output_dir, f'{stem}-accompaniment.wav')
        if need_sep:
            if self.stop_event.is_set():
                raise RuntimeError('已被用户停止')
            print(f'[Manual] ({file_idx}/{total}) 开始 Demucs 人声分离（首次加载模型约2分钟）...', flush=True)
            self.stats['current_step'] = '人声分离中'

            def _sep_cb(p, _idx=file_idx, _tot=total):
                self.stats['progress'] = int(((_idx - 1) + p / 100.0) / _tot * 100)
                self.stats['current_step'] = f'第 {_idx}/{_tot} 个 · 分离 {p}%'

            DEMUCS_ENGINE.separate(src, vocals_path, accomp_path, progress_cb=_sep_cb)
            output_files.append(vocals_path)
            output_files.append(accomp_path)
            print(f'[Manual] ({file_idx}/{total}) 分离完成: {os.path.basename(vocals_path)}', flush=True)

        # 逐字对齐
        need_align = task in ('align', 'both')
        if need_align:
            if self.stop_event.is_set():
                raise RuntimeError('已被用户停止')
            align_src = vocals_path if (need_sep and os.path.exists(vocals_path)) else src
            print(f'[Manual] ({file_idx}/{total}) 开始 WhisperX 逐字对齐 (源: {os.path.basename(align_src)})...', flush=True)
            self.stats['current_step'] = '逐字对齐中'

            def _align_cb(p, _idx=file_idx, _tot=total, _need_sep=need_sep):
                if _need_sep:
                    self.stats['progress'] = int(((_idx - 1) + 0.5 + p / 200.0) / _tot * 100)
                else:
                    self.stats['progress'] = int(((_idx - 1) + p / 100.0) / _tot * 100)
                self.stats['current_step'] = f'第 {_idx}/{_tot} 个 · 对齐 {p}%'

            lrc_text = WHISPER_ENGINE.align(align_src, ref_text='', progress_cb=_align_cb)
            lrc_path = os.path.join(output_dir, f'{stem}.lrc')
            with open(lrc_path, 'w', encoding='utf-8') as f:
                f.write(lrc_text)
            output_files.append(lrc_path)
            print(f'[Manual] ({file_idx}/{total}) 对齐完成: {os.path.basename(lrc_path)} ({lrc_text.count(chr(10))} 行)', flush=True)
        return output_files

    def _run(self, paths, output_dir, task, upload_back):
        import tempfile, shutil, urllib.parse
        total = len(paths)
        all_output_files = []
        tmp_dirs = []
        try:
            os.makedirs(output_dir, exist_ok=True)
            print(f'[Manual] 共 {total} 个文件待处理，输出目录: {output_dir}，任务: {task}', flush=True)

            for idx, item in enumerate(paths, start=1):
                if self.stop_event.is_set():
                    raise RuntimeError('已被用户停止')
                self.stats['current_file'] = item
                self.stats['current_step'] = f'第 {idx}/{total} 个'
                print(f'[Manual] ── ({idx}/{total}) {item}', flush=True)

                src = item
                tmp_dir = None
                if item.startswith('http://') or item.startswith('https://'):
                    print(f'[Manual] 下载网络音频: {item}', flush=True)
                    self.stats['current_step'] = f'第 {idx}/{total} 个 · 下载中'
                    tmp_dir = tempfile.mkdtemp(prefix='momo_manual_')
                    tmp_dirs.append(tmp_dir)
                    parsed = urllib.parse.urlparse(item)
                    ext = os.path.splitext(parsed.path)[1] or '.mp3'
                    src = os.path.join(tmp_dir, 'source' + ext)
                    with requests.get(item, stream=True, timeout=600) as r:
                        r.raise_for_status()
                        with open(src, 'wb') as f:
                            for chunk in r.iter_content(1 << 20):
                                f.write(chunk)
                    print(f'[Manual] 下载完成: {os.path.getsize(src)//1024} KB', flush=True)
                else:
                    if not os.path.exists(item):
                        raise FileNotFoundError(f'文件不存在: {item}')

                stem = os.path.splitext(os.path.basename(src))[0]
                files = self._run_one(src, output_dir, stem, task, upload_back, idx, total)
                all_output_files.extend(files)
                self.stats['done_files'] = idx
                self.stats['output_files'] = all_output_files

            if upload_back:
                print('[Manual] 提示: upload_back=true，但自定义文件处理无对应歌曲ID，跳过回传', flush=True)

            self.stats['progress'] = 100
            self.stats['current_step'] = '全部完成'
            print(f'[Manual] ✅ 全部完成，共处理 {total} 个文件，输出 {len(all_output_files)} 个文件', flush=True)

        except Exception as e:
            self.stats['error'] = str(e)
            self.stats['current_step'] = '失败'
            print(f'[Manual] ❌ 失败: {e}', flush=True)
        finally:
            self.running = False
            for d in tmp_dirs:
                shutil.rmtree(d, ignore_errors=True)


# ============================================================================
# 全局单例
# ============================================================================
manager = None
convert_manager = None
manual_manager = None
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
        elif path == '/api/convert/status':
            self._send_json(convert_manager.get_status() if convert_manager else {'running': False})
        elif path == '/api/convert/logs':
            since = 0
            qs = self.path.split('?')[1] if '?' in self.path else ''
            for kv in qs.split('&'):
                if kv.startswith('since='):
                    try: since = int(kv[6:])
                    except: pass
            lines = convert_manager.get_logs(since) if convert_manager else []
            self._send_json({'lines': lines, 'latest_id': convert_manager.log_id if convert_manager else 0})
        elif path == '/api/manual/status':
            self._send_json(manual_manager.get_status() if manual_manager else {'running': False})
        elif path == '/api/browse':
            # 目录浏览 API：返回指定目录下的子目录和音频文件
            qs = self.path.split('?')[1] if '?' in self.path else ''
            browse_path = ''
            for kv in qs.split('&'):
                if kv.startswith('path='):
                    browse_path = urllib.parse.unquote(kv[5:])
            self._send_json(self._list_dir(browse_path))
        elif path == '/api/ktv/no-lyrics':
            # 从 momo-ktv 服务端获取无逐字歌词的音频歌曲列表（预览/勾选用）
            qs = self.path.split('?')[1] if '?' in self.path else ''
            limit = 100
            for kv in qs.split('&'):
                if kv.startswith('limit='):
                    try:
                        limit = max(1, min(500, int(kv[6:])))
                    except Exception:
                        pass
            try:
                r = requests.get(f'{manager.server}/api/songs/no-lyrics',
                                 params={'limit': limit}, timeout=15)
                self._send_json(r.json())
            except Exception as e:
                self._send_json({'ok': False, 'error': str(e)}, 500)
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
        elif path == '/api/convert/start':
            ok, msg = convert_manager.start(data)
            self._send_json({'ok': ok, 'msg': msg})
        elif path == '/api/convert/stop':
            ok, msg = convert_manager.stop()
            self._send_json({'ok': ok, 'msg': msg})
        elif path == '/api/manual/enqueue':
            # 代理到服务端的 /api/separate/enqueue
            song_ids = data.get('song_ids', [])
            job_type = data.get('type', 'separate')
            force = data.get('force', False)
            try:
                r = requests.post(f'{manager.server}/api/separate/enqueue',
                                  json={'song_ids': song_ids, 'type': job_type, 'force': force}, timeout=30)
                self._send_json(r.json())
            except Exception as e:
                self._send_json({'ok': False, 'error': str(e)}, 500)
        elif path == '/api/manual/upload-lyrics':
            # 代理到服务端的 /api/cloud-lyrics/upload
            song_ids = data.get('song_ids', [])
            try:
                r = requests.post(f'{manager.server}/api/cloud-lyrics/upload',
                                  json={'song_ids': song_ids}, timeout=30)
                self._send_json(r.json())
            except Exception as e:
                self._send_json({'ok': False, 'error': str(e)}, 500)
        elif path == '/api/manual/process-file':
            input_paths = data.get('input_path', '').strip()
            output_dir = data.get('output_dir', '').strip()
            task = data.get('task', 'both')
            upload_back = bool(data.get('upload_back', False))
            if not input_paths or not output_dir:
                self._send_json({'ok': False, 'error': 'input_path 和 output_dir 不能为空'}, 400)
                return
            ok, msg = manual_manager.start(input_paths, output_dir, task, upload_back)
            self._send_json({'ok': ok, 'msg': msg})
        elif path == '/api/manual/stop':
            ok, msg = manual_manager.stop()
            self._send_json({'ok': ok, 'msg': msg})
        else:
            self._send_json({'error': 'not found'}, 404)

    def _list_dir(self, dir_path):
        """目录浏览：返回子目录和音频文件列表"""
        import string as _string
        audio_exts = {'.flac','.wav','.mp3','.m4a','.ape','.ogg','.aac','.wma','.dsf','.dff','.strm'}
        try:
            if not dir_path or dir_path == '/':
                drives = []
                for c in _string.ascii_uppercase:
                    d = c + ':\\'
                    if os.path.exists(d):
                        drives.append({'name': d, 'path': d, 'type': 'drive'})
                return {'path': '', 'parent': '', 'dirs': drives, 'files': []}
            dir_path = os.path.normpath(dir_path)
            if not os.path.isdir(dir_path):
                return {'path': dir_path, 'parent': '', 'dirs': [], 'files': [], 'error': '目录不存在'}
            parent = os.path.dirname(dir_path)
            dirs = []
            files = []
            for name in sorted(os.listdir(dir_path)):
                full = os.path.join(dir_path, name)
                try:
                    if os.path.isdir(full):
                        dirs.append({'name': name, 'path': full, 'type': 'dir'})
                    else:
                        ext = os.path.splitext(name)[1].lower()
                        if ext in audio_exts:
                            size = os.path.getsize(full)
                            files.append({'name': name, 'path': full, 'type': 'file', 'size': size})
                except Exception:
                    pass
            return {'path': dir_path, 'parent': parent, 'dirs': dirs, 'files': files}
        except Exception as e:
            return {'path': dir_path, 'parent': '', 'dirs': [], 'files': [], 'error': str(e)}

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
<title>墨墨爱K歌 · AI 工作站</title>
<style>
:root{
  --bg:#0a0e1a;--bg2:#111827;--card:#1a2236;--card2:#222d45;
  --border:#2d3a52;--text:#e2e8f0;--muted:#8892a8;--accent:#38bdf8;
  --accent2:#818cf8;--green:#34d399;--red:#f87171;--orange:#fb923c;
  --purple:#c084fc;--teal:#2dd4bf;
}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden}
body::before{content:'';position:fixed;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,var(--accent),var(--accent2),var(--purple));z-index:100}

/* 顶部导航 */
.topbar{display:flex;align-items:center;justify-content:space-between;padding:14px 28px;background:linear-gradient(180deg,rgba(26,34,54,.95),rgba(17,24,39,.8));backdrop-filter:blur(12px);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:50;flex-wrap:wrap;gap:12px}
.brand{display:flex;align-items:center;gap:14px}
.logo{width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;font-size:20px;box-shadow:0 0 24px rgba(56,189,248,.4)}
.brand h1{font-size:17px;font-weight:700;background:linear-gradient(90deg,var(--accent),var(--accent2));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.brand .sub{font-size:11px;color:var(--muted);margin-top:2px}
.top-right{display:flex;align-items:center;gap:12px}
.status-pill{display:flex;align-items:center;gap:8px;padding:6px 14px;border-radius:20px;background:var(--card);border:1px solid var(--border);font-size:13px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--muted);transition:.3s}
.dot.on{background:var(--green);box-shadow:0 0 10px var(--green);animation:pulse 2s infinite}
.dot.off{background:var(--red)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.btn{padding:8px 18px;border-radius:10px;border:none;cursor:pointer;font-size:13px;font-weight:600;transition:.2s;display:inline-flex;align-items:center;gap:7px}
.btn-start{background:linear-gradient(135deg,var(--green),#059669);color:#fff;box-shadow:0 4px 14px rgba(52,211,153,.3)}
.btn-start:hover{transform:translateY(-1px)}
.btn-stop{background:linear-gradient(135deg,var(--red),#dc2626);color:#fff;box-shadow:0 4px 14px rgba(248,113,113,.3)}
.btn-stop:hover{transform:translateY(-1px)}
.btn:disabled{opacity:.4;cursor:not-allowed}

/* 主内容 */
.main{max-width:1400px;margin:0 auto;padding:20px 28px 60px}

/* 区域标题 */
.section-header{display:flex;align-items:center;gap:12px;margin:28px 0 14px;padding-bottom:10px;border-bottom:1px solid var(--border)}
.section-header .icon{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px}
.section-header.sep .icon{background:linear-gradient(135deg,rgba(56,189,248,.2),rgba(129,140,248,.2));border:1px solid var(--accent)}
.section-header.align .icon{background:linear-gradient(135deg,rgba(192,132,252,.2),rgba(129,140,248,.2));border:1px solid var(--purple)}
.section-header.convert .icon{background:linear-gradient(135deg,rgba(45,212,191,.2),rgba(56,189,248,.2));border:1px solid var(--teal)}
.section-header h2{font-size:18px;font-weight:700}
.section-header .desc{font-size:11px;color:var(--muted);margin-left:auto}

/* 统计卡片 */
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.stat-card{background:linear-gradient(135deg,var(--card),var(--card2));border:1px solid var(--border);border-radius:14px;padding:16px 18px;position:relative;overflow:hidden;transition:.3s}
.stat-card:hover{transform:translateY(-2px);border-color:var(--accent)}
.stat-card::after{content:'';position:absolute;top:0;right:0;width:70px;height:70px;border-radius:50%;filter:blur(35px);opacity:.25}
.stat-card:nth-child(1)::after{background:var(--accent)}
.stat-card:nth-child(2)::after{background:var(--orange)}
.stat-card:nth-child(3)::after{background:var(--green)}
.stat-card:nth-child(4)::after{background:var(--red)}
.stat-label{font-size:11px;color:var(--muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px}
.stat-value{font-size:28px;font-weight:800;line-height:1}
.stat-value .unit{font-size:13px;color:var(--muted);font-weight:400;margin-left:3px}
.stat-sub{font-size:11px;color:var(--muted);margin-top:6px}

/* 控制面板 */
.panel{background:linear-gradient(135deg,var(--card),var(--card2));border:1px solid var(--border);border-radius:14px;padding:18px}
.control-row{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.ctrl-group{margin-bottom:14px}
.ctrl-label{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.ctrl-label span{font-size:12px;color:var(--muted)}
.ctrl-label .val{font-size:18px;font-weight:700;color:var(--accent)}
input[type=range]{width:100%;height:5px;-webkit-appearance:none;background:var(--bg2);border-radius:3px;outline:none}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:20px;height:20px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2));cursor:pointer;box-shadow:0 0 10px rgba(56,189,248,.5);border:2px solid #fff}
.quick-btns{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}
.quick-btn{padding:5px 12px;border-radius:7px;background:var(--bg2);border:1px solid var(--border);color:var(--text);cursor:pointer;font-size:11px;transition:.2s}
.quick-btn:hover{border-color:var(--accent);color:var(--accent)}
.quick-btn.active{background:var(--accent);color:#000;border-color:var(--accent);font-weight:600}
.btn-apply{width:100%;padding:11px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#000;border:none;border-radius:9px;font-size:14px;font-weight:700;cursor:pointer;transition:.2s;margin-top:6px}
.btn-apply:hover{transform:translateY(-1px);box-shadow:0 5px 18px rgba(56,189,248,.4)}

/* GPU 卡片 */
.gpu-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
.gpu-item{background:var(--bg2);border-radius:9px;padding:10px 12px}
.gpu-item .lbl{font-size:10px;color:var(--muted);margin-bottom:3px}
.gpu-item .v{font-size:16px;font-weight:700}
.mem-bar{height:6px;background:var(--bg);border-radius:3px;overflow:hidden;margin-top:6px}
.mem-fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:3px;transition:width .5s}
.gpu-name{font-size:11px;color:var(--muted);margin-bottom:10px;padding:7px 10px;background:var(--bg2);border-radius:7px;text-align:center}

/* 线程列表 */
.thread-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:12px}
.thread-card{background:linear-gradient(135deg,var(--card),var(--card2));border:1px solid var(--border);border-radius:13px;padding:14px 16px;transition:.3s;position:relative}
.thread-card.active-sep{border-color:var(--accent);box-shadow:0 0 16px rgba(56,189,248,.12)}
.thread-card.active-align{border-color:var(--purple);box-shadow:0 0 16px rgba(192,132,252,.12)}
.thread-card.idle{opacity:.65}
.thread-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.thread-name{font-size:14px;font-weight:700;display:flex;align-items:center;gap:7px}
.thread-name .idx{width:24px;height:24px;border-radius:7px;background:var(--bg2);display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--accent)}
.badge{padding:2px 9px;border-radius:11px;font-size:10px;font-weight:600}
.badge.run{background:rgba(52,211,153,.15);color:var(--green)}
.badge.idle{background:rgba(136,146,168,.15);color:var(--muted)}
.badge.sep{background:rgba(56,189,248,.15);color:var(--accent)}
.badge.align{background:rgba(192,132,252,.15);color:var(--purple)}
.job-info{font-size:12px;margin-bottom:5px;line-height:1.5}
.job-info .title{color:var(--text);font-weight:600}
.job-info .artist{color:var(--muted);font-size:11px}
.progress-wrap{margin:8px 0}
.progress-bar{height:5px;background:var(--bg);border-radius:3px;overflow:hidden}
.progress-fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:3px;transition:width .4s}
.progress-text{display:flex;justify-content:space-between;font-size:10px;color:var(--muted);margin-top:4px}
.thread-stats{display:flex;gap:12px;margin-top:8px;padding-top:8px;border-top:1px solid var(--border);font-size:11px}
.thread-stats span{color:var(--muted)}
.thread-stats b{color:var(--text)}
.err-msg{font-size:10px;color:var(--red);margin-top:5px;padding:5px 8px;background:rgba(248,113,113,.08);border-radius:6px;word-break:break-all}

/* 说明框 */
.info-box{background:linear-gradient(135deg,rgba(192,132,252,.08),rgba(129,140,248,.05));border:1px solid rgba(192,132,252,.2);border-radius:12px;padding:14px 18px;font-size:12px;color:var(--muted);line-height:1.8;margin-bottom:14px}
.info-box b{color:var(--purple)}

/* 转码配置表单 */
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.form-item{margin-bottom:4px}
.form-item label{display:block;font-size:11px;color:var(--muted);margin-bottom:4px}
.form-item input,.form-item select{width:100%;padding:8px 10px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:12px;outline:none;transition:.2s}
.form-item input:focus,.form-item select:focus{border-color:var(--accent)}
.form-item.full{grid-column:1/-1}
.form-row{display:flex;gap:10px;align-items:flex-end;margin-top:12px}
.form-row .btn{flex:1;padding:11px}
.checkbox-item{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);padding:8px 0}
.checkbox-item input{width:16px;height:16px;accent-color:var(--teal)}

/* 转码进度 */
.convert-progress{margin:14px 0}
.convert-progress .pbar{height:10px;background:var(--bg);border-radius:5px;overflow:hidden}
.convert-progress .pfill{height:100%;background:linear-gradient(90deg,var(--teal),var(--accent));border-radius:5px;transition:width .5s}
.convert-progress .ptext{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-top:6px}
.convert-current{font-size:12px;color:var(--teal);margin-top:8px;padding:8px 12px;background:rgba(45,212,191,.08);border-radius:8px;word-break:break-all}

/* 日志面板 */
.log-panel{background:var(--card);border:1px solid var(--border);border-radius:14px;overflow:hidden}
.log-head{display:flex;justify-content:space-between;align-items:center;padding:10px 16px;background:var(--bg2);border-bottom:1px solid var(--border)}
.log-head .title{font-size:13px;font-weight:600;display:flex;align-items:center;gap:7px}
.log-head .title .live{width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse 1.5s infinite}
.log-controls{display:flex;gap:6px;align-items:center}
.log-btn{padding:4px 10px;border-radius:6px;background:var(--card);border:1px solid var(--border);color:var(--muted);cursor:pointer;font-size:11px;transition:.2s}
.log-btn:hover{color:var(--text);border-color:var(--accent)}
.log-btn.active{color:var(--accent);border-color:var(--accent)}
.log-body{height:240px;overflow-y:auto;padding:10px 16px;font-family:'Consolas','Courier New',monospace;font-size:11px;line-height:1.7;background:#0d1117}
.log-line{white-space:pre-wrap;word-break:break-all}
.log-line .t{color:#6e7681;margin-right:7px}
.log-line .tn{color:#38bdf8;margin-right:5px;font-weight:600}
.log-line.err{color:#f87171}
.log-line.warn{color:#fb923c}
.log-body::-webkit-scrollbar{width:5px}
.log-body::-webkit-scrollbar-track{background:transparent}
.log-body::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}

.empty{text-align:center;padding:30px 20px;color:var(--muted);font-size:13px}
.empty .icon{font-size:36px;margin-bottom:8px;opacity:.4}

.sub-title{font-size:13px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin:18px 0 10px;display:flex;align-items:center;gap:8px}
.sub-title::before{content:'';width:3px;height:13px;background:var(--accent);border-radius:2px}

@media(max-width:900px){
  .stats{grid-template-columns:repeat(2,1fr)}
  .control-row{grid-template-columns:1fr}
  .form-grid{grid-template-columns:1fr}
  .topbar{flex-direction:column;align-items:stretch}
}
</style>
</head>
<body>

<div class="topbar">
  <div class="brand">
    <div class="logo">🎵</div>
    <div>
      <h1>墨墨爱K歌 · AI 工作站</h1>
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

<!-- ==================== 区域1：人声分离 ==================== -->
<div class="section-header sep">
  <div class="icon">🎵</div>
  <h2>人声分离</h2>
  <span class="desc">Demucs htdemucs · GPU 加速 · 多线程并发</span>
</div>

<div class="stats">
  <div class="stat-card">
    <div class="stat-label">分离中任务</div>
    <div class="stat-value" id="sepActive">0<span class="unit">首</span></div>
    <div class="stat-sub" id="sepThreads">0 个线程</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">运行时长</div>
    <div class="stat-value" id="sepUptime">0<span class="unit">分</span></div>
    <div class="stat-sub">本次启动后</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">已完成分离</div>
    <div class="stat-value" id="sepDone" style="color:var(--green)">0<span class="unit">首</span></div>
    <div class="stat-sub">Demucs htdemucs</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">失败</div>
    <div class="stat-value" id="sepFail" style="color:var(--red)">0<span class="unit">首</span></div>
    <div class="stat-sub">自动重试不影响</div>
  </div>
</div>

<div class="sub-title">线程控制 & GPU 监控</div>
<div class="control-row">
  <div class="panel">
    <div class="ctrl-group">
      <div class="ctrl-label">
        <span>并发线程数（分离+对齐共用，动态调节无需重启）</span>
        <span class="val" id="threadVal">2</span>
      </div>
      <input type="range" id="threadSlider" min="1" max="16" value="2" oninput="document.getElementById('threadVal').textContent=this.value">
      <div class="quick-btns">
        <button class="quick-btn" onclick="setQuick(1,this)">1</button>
        <button class="quick-btn active" onclick="setQuick(2,this)">2</button>
        <button class="quick-btn" onclick="setQuick(4,this)">4</button>
        <button class="quick-btn" onclick="setQuick(6,this)">6</button>
        <button class="quick-btn" onclick="setQuick(8,this)">8</button>
        <button class="quick-btn" onclick="setQuick(12,this)">12</button>
        <button class="quick-btn" onclick="setQuick(16,this)">16</button>
      </div>
    </div>
    <button class="btn-apply" onclick="applyThreads()">应用线程数</button>
    <div style="font-size:10px;color:var(--muted);margin-top:8px;line-height:1.6">
      💡 4070TiS 16G 推荐 2~3 线程；减少线程时被撤线程跑完当前歌曲后退出。
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
        <div class="v" id="gpuCap" style="font-size:13px">--</div>
      </div>
    </div>
  </div>
</div>

<div class="sub-title">线程状态（人声分离任务高亮）</div>
<div class="thread-grid" id="sepThreadGrid">
  <div class="empty"><div class="icon">⚙️</div>Worker 未启动，点击右上角「启动 Worker」</div>
</div>

<div class="sub-title">实时日志</div>
<div class="log-panel">
  <div class="log-head">
    <div class="title"><div class="live"></div>人声分离 / 逐字对齐 运行日志</div>
    <div class="log-controls">
      <button class="log-btn active" id="btnAutoScroll" onclick="toggleAutoScroll()">自动滚动</button>
      <button class="log-btn" id="btnPauseLog" onclick="togglePauseLog()">暂停</button>
      <button class="log-btn" onclick="clearLog()">清屏</button>
    </div>
  </div>
  <div class="log-body" id="logBody"></div>
</div>

<!-- ==================== 区域2：逐字歌词 ==================== -->
<div class="section-header align">
  <div class="icon">📝</div>
  <h2>逐字歌词对齐</h2>
  <span class="desc">WhisperX large-v3 · 逐字时间戳 · 官方参考歌词纠错</span>
</div>

<div class="stats">
  <div class="stat-card">
    <div class="stat-label">对齐中任务</div>
    <div class="stat-value" id="alignActive">0<span class="unit">首</span></div>
    <div class="stat-sub" id="alignThreads">0 个线程</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">运行时长</div>
    <div class="stat-value" id="alignUptime">0<span class="unit">分</span></div>
    <div class="stat-sub">本次启动后</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">已完成对齐</div>
    <div class="stat-value" id="alignDone" style="color:var(--purple)">0<span class="unit">首</span></div>
    <div class="stat-sub">WhisperX large-v3</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">失败</div>
    <div class="stat-value" id="alignFail" style="color:var(--red)">0<span class="unit">首</span></div>
    <div class="stat-sub">自动重试不影响</div>
  </div>
</div>

<div class="info-box">
  逐字歌词对齐使用 <b>WhisperX large-v3</b>，对每首歌生成逐字时间戳 LRC（电视端逐字变色）。
  对齐优先使用分离出的纯人声（更精准），无分离产物时直接用源音频。支持官方参考歌词纠错（同音字/错字校正）。
  纯音乐/轻音乐/无人声音频自动跳过对齐，生成空 LRC。
</div>

<div class="sub-title">线程状态（逐字对齐任务高亮）</div>
<div class="thread-grid" id="alignThreadGrid">
  <div class="empty"><div class="icon">📝</div>Worker 未启动，点击右上角「启动 Worker」</div>
</div>

<!-- ==================== 区域：手动批量操作 ==================== -->
<div class="section-header" style="border-color:var(--orange)">
  <div class="icon" style="background:linear-gradient(135deg,rgba(251,146,60,.2),rgba(248,113,113,.2));border:1px solid var(--orange)">⚡</div>
  <h2>手动批量操作</h2>
  <span class="desc">手动选择歌曲ID批量触发分离/对齐/上传，不影响自动模式</span>
</div>
<div class="panel">
  <div class="form-grid">
    <div class="form-item full">
      <label>歌曲 ID 列表（逗号分隔，支持范围如 100-200，或混合：1,5,10-20,50）</label>
      <input type="text" id="manualIds" placeholder="例如：100,200,300-350" style="font-family:Consolas,monospace">
    </div>
    <div class="form-item">
      <label>任务类型</label>
      <select id="manualType">
        <option value="both">分离+对齐（先分离后对齐）</option>
        <option value="separate">仅人声分离</option>
        <option value="align">仅逐字对齐</option>
      </select>
    </div>
    <div class="form-item">
      <label>强制重做</label>
      <select id="manualForce">
        <option value="false">否（跳过已完成的）</option>
        <option value="true">是（已完成的也重新排队）</option>
      </select>
    </div>
  </div>
  <div class="form-row">
    <button class="btn btn-start" onclick="manualEnqueue()">▶ 批量入队</button>
    <button class="btn" style="background:linear-gradient(135deg,var(--purple),#7c3aed);color:#fff" onclick="manualUploadLyrics()">☁️ 上传歌词到网盘</button>
  </div>
  <div id="manualResult" style="margin-top:12px;font-size:12px;color:var(--muted);line-height:1.8"></div>
  <div style="font-size:10px;color:var(--muted);margin-top:8px;line-height:1.6">
    💡 入队后 Worker 会自动领取处理（需 Worker 处于运行状态）。上传歌词仅对已有逐字歌词(lyrics_word)的 audio 歌曲有效，115云盘可写，移动云盘不支持写入。
  </div>
  <!-- 无歌词歌曲预览选择：从KTV拉取无逐字歌词的audio歌曲，勾选后批量入队/上传 -->
  <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border)">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
      <button class="btn" style="background:linear-gradient(135deg,var(--teal),#0d9488);color:#fff;font-size:12px" onclick="fetchNoLyrics()">🔍 从KTV获取无歌词歌曲</button>
      <span id="noLyricsInfo" style="font-size:12px;color:var(--muted)"></span>
    </div>
    <div id="noLyricsList" style="display:none;max-height:320px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:8px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--bg);z-index:1;flex-wrap:wrap">
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
          <input type="checkbox" id="noLyricsSelectAll" onchange="toggleSelectAllNoLyrics(this.checked)" style="accent-color:var(--teal)"> 全选
        </label>
        <span id="noLyricsSelected" style="font-size:12px;color:var(--teal);font-weight:bold">已选 0 首</span>
        <div style="margin-left:auto;display:flex;gap:6px">
          <button class="btn btn-start" style="font-size:11px;padding:4px 12px" onclick="enqueueSelectedNoLyrics()">▶ 入队所选</button>
          <button class="btn" style="font-size:11px;padding:4px 12px;background:linear-gradient(135deg,var(--purple),#7c3aed);color:#fff" onclick="uploadSelectedNoLyrics()">☁️ 上传歌词</button>
        </div>
      </div>
      <div id="noLyricsItems"></div>
    </div>
  </div>
</div>

<div class="sub-title" style="margin-top:18px">自定义文件处理（不经数据库，本机直接推理）</div>
<div class="panel">
  <div class="form-grid">
    <div class="form-item full">
      <label>源文件路径（本地路径或 http(s) URL，每行一个，或用逗号分隔）</label>
      <div style="display:flex;gap:6px;align-items:flex-start">
        <textarea id="mpInput" rows="3" placeholder="C:\\music\\song1.flac&#10;C:\\music\\song2.flac&#10;https://xxx.com/song3.flac" style="flex:1;padding:8px 10px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:12px;outline:none;font-family:Consolas,monospace;resize:vertical"></textarea>
        <button class="btn" style="padding:8px 12px;white-space:nowrap;background:linear-gradient(135deg,var(--teal),#0d9488);color:#fff;font-size:12px" onclick="openBrowser('file')">📁 浏览</button>
      </div>
    </div>
    <div class="form-item full">
      <label>输出目录（产物保存到此目录）</label>
      <div style="display:flex;gap:6px">
        <input type="text" id="mpOutput" placeholder="例如：D:\\output\\" style="flex:1;font-family:Consolas,monospace">
        <button class="btn" style="padding:8px 12px;white-space:nowrap;background:linear-gradient(135deg,var(--teal),#0d9488);color:#fff;font-size:12px" onclick="openBrowser('dir')">📁 浏览</button>
      </div>
    </div>
    <div class="form-item">
      <label>任务类型</label>
      <select id="mpTask">
        <option value="both">分离+对齐</option>
        <option value="separate">仅人声分离</option>
        <option value="align">仅逐字对齐</option>
      </select>
    </div>
    <div class="form-item">
      <label>回传服务端（需有对应歌曲ID，自定义文件通常无需）</label>
      <select id="mpUploadBack">
        <option value="false">否</option>
        <option value="true">是</option>
      </select>
    </div>
  </div>
  <div class="form-row">
    <button class="btn btn-start" id="mpStartBtn" onclick="manualProcessFile()">▶ 开始处理</button>
    <button class="btn btn-stop" id="mpStopBtn" onclick="manualStopFile()" style="display:none">■ 停止</button>
  </div>
  <div id="mpStatus" style="margin-top:12px;font-size:12px;color:var(--muted);line-height:1.8"></div>
  <div id="mpFiles" style="margin-top:8px;font-size:11px;color:var(--teal);line-height:1.8"></div>
</div>

<!-- ==================== 区域3：FLAC转码 ==================== -->
<div class="section-header convert">
  <div class="icon">🎼</div>
  <h2>FLAC 音频转码</h2>
  <span class="desc">ffmpeg 无损转码 · cue 整轨切分 / 单曲转换 · 多进程并发</span>
</div>

<div class="stats">
  <div class="stat-card">
    <div class="stat-label">转码进度</div>
    <div class="stat-value" id="convProgress">0<span class="unit">%</span></div>
    <div class="stat-sub" id="convCount">0 / 0 专辑</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">成功</div>
    <div class="stat-value" id="convOk" style="color:var(--green)">0<span class="unit">首</span></div>
    <div class="stat-sub">无损 FLAC</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">跳过</div>
    <div class="stat-value" id="convSkip" style="color:var(--teal)">0<span class="unit">首</span></div>
    <div class="stat-sub">已存在非空文件</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">失败</div>
    <div class="stat-value" id="convFail" style="color:var(--red)">0<span class="unit">首</span></div>
    <div class="stat-sub" id="convTime">用时 0 分钟</div>
  </div>
</div>

<div class="sub-title">转码配置</div>
<div class="panel">
  <div class="form-grid">
    <div class="form-item full">
      <label>源音乐根目录（SMB 路径或本地路径）</label>
      <input type="text" id="cfgRoot" value="\\192.168.3.80\music">
    </div>
    <div class="form-item full">
      <label>输出根目录（留空则为 源目录\all-flacs）</label>
      <input type="text" id="cfgOutRoot" value="">
    </div>
    <div class="form-item">
      <label>转码模式</label>
      <select id="cfgMode">
        <option value="cue">cue 整轨切分（推荐）</option>
        <option value="single">single 单曲转换</option>
      </select>
    </div>
    <div class="form-item">
      <label>并发进程数</label>
      <input type="number" id="cfgWorkers" value="8" min="1" max="32">
    </div>
    <div class="form-item">
      <label>只处理路径含此关键词（留空=全部）</label>
      <input type="text" id="cfgOnly" value="">
    </div>
    <div class="form-item">
      <label>最多处理 N 个（0=不限）</label>
      <input type="number" id="cfgLimit" value="0" min="0">
    </div>
    <div class="form-item full">
      <div class="checkbox-item">
        <input type="checkbox" id="cfgDry">
        <label for="cfgDry" style="margin:0;cursor:pointer">试运行（只规划不转码，验证扫描结果）</label>
      </div>
    </div>
  </div>
  <div class="form-row">
    <button class="btn btn-start" id="btnConvStart" onclick="startConvert()">▶ 启动转码</button>
    <button class="btn btn-stop" id="btnConvStop" onclick="stopConvert()" style="display:none">■ 停止转码</button>
  </div>
</div>

<div class="sub-title">转码进度</div>
<div class="panel">
  <div class="convert-progress">
    <div class="pbar"><div class="pfill" id="convPbar" style="width:0%"></div></div>
    <div class="ptext">
      <span id="convPtext">等待启动...</span>
      <span id="convPct">0%</span>
    </div>
  </div>
  <div class="convert-current" id="convCurrent" style="display:none">当前处理：--</div>
</div>

<div class="sub-title">转码实时日志</div>
<div class="log-panel">
  <div class="log-head">
    <div class="title"><div class="live" id="convLogLive" style="background:var(--muted)"></div>flac_convert.py 输出</div>
    <div class="log-controls">
      <button class="log-btn active" id="btnConvAutoScroll" onclick="toggleConvAutoScroll()">自动滚动</button>
      <button class="log-btn" onclick="clearConvLog()">清屏</button>
    </div>
  </div>
  <div class="log-body" id="convLogBody"></div>
</div>

</div>

<script>
let workerRunning = false;
let workerStatus = null;
let convertStatus = null;
let logSince = 0, convLogSince = 0;
let autoScroll = true, convAutoScroll = true;
let pauseLog = false;

function fmtTime(sec){
  if(sec<60)return sec+'秒';
  if(sec<3600)return Math.floor(sec/60)+'分';
  return Math.floor(sec/3600)+'时'+Math.floor((sec%3600)/60)+'分';
}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

// ---------- Worker 状态 ----------
async function fetchWorkerStatus(){
  try{
    const r = await fetch('/api/status');
    const d = await r.json();
    workerStatus = d;
    workerRunning = d.running;
    // 顶部状态
    const dot=document.getElementById('statusDot'), st=document.getElementById('statusText');
    if(workerRunning){dot.className='dot on';st.textContent='运行中';}
    else{dot.className='dot off';st.textContent='已停止';}
    document.getElementById('btnStart').style.display=workerRunning?'none':'inline-flex';
    document.getElementById('btnStop').style.display=workerRunning?'inline-flex':'none';
    document.getElementById('serverInfo').textContent=`${d.server} · ${d.worker_name} · ${d.mode} · ${d.capability}`;

    // 统计 separate / align
    let sepActive=0, alignActive=0;
    (d.threads||[]).forEach(t=>{
      if(t.active && t.job){
        if(t.job.type==='separate') sepActive++;
        else if(t.job.type==='align') alignActive++;
      }
    });

    // 人声分离统计
    document.getElementById('sepActive').innerHTML=`${sepActive}<span class="unit">首</span>`;
    document.getElementById('sepThreads').textContent=`${d.thread_count} 个线程`;
    document.getElementById('sepUptime').textContent=fmtTime(d.uptime);
    document.getElementById('sepDone').innerHTML=`${d.total_done}<span class="unit">首</span>`;
    document.getElementById('sepFail').innerHTML=`${d.total_fail}<span class="unit">首</span>`;

    // 逐字对齐统计
    document.getElementById('alignActive').innerHTML=`${alignActive}<span class="unit">首</span>`;
    document.getElementById('alignThreads').textContent=`${d.thread_count} 个线程`;
    document.getElementById('alignUptime').textContent=fmtTime(d.uptime);
    document.getElementById('alignDone').innerHTML=`${d.total_done}<span class="unit">首</span>`;
    document.getElementById('alignFail').innerHTML=`${d.total_fail}<span class="unit">首</span>`;

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

    // 线程列表（两个区域分别高亮不同类型）
    renderThreadGrid('sepThreadGrid', d.threads, 'separate');
    renderThreadGrid('alignThreadGrid', d.threads, 'align');
  }catch(e){console.error(e)}
}

function renderThreadGrid(elId, threads, filterType){
  const grid = document.getElementById(elId);
  if(!threads||threads.length===0){
    grid.innerHTML='<div class="empty"><div class="icon">⚙️</div>Worker 未启动，点击右上角「启动 Worker」</div>';
    return;
  }
  grid.innerHTML = threads.map((t,i)=>{
    const active = t.active && t.job;
    let cls = 'idle';
    if(active){
      cls = t.job.type===filterType ? `active-${filterType}` : '';
    }
    const badge = active
      ? `<span class="badge ${t.job.type==='separate'?'sep':'align'}">${t.job.type==='separate'?'人声分离':'逐字对齐'}</span>`
      : '<span class="badge idle">空闲</span>';
    let jobHtml = '';
    if(active && t.job){
      const jp = t.job.progress||0;
      jobHtml = `
        <div class="job-info"><span class="title">${esc(t.job.title||'未知')}</span></div>
        <div class="job-info artist">${esc(t.job.artist||'')} · #${t.job.id}</div>
        <div class="progress-wrap">
          <div class="progress-bar"><div class="progress-fill" style="width:${jp}%"></div></div>
          <div class="progress-text"><span>进度 ${jp}%</span><span>已用 ${t.elapsed||0}秒</span></div>
        </div>`;
    } else {
      jobHtml = '<div class="job-info" style="color:var(--muted)">等待任务...</div>';
    }
    const err = t.last_error?`<div class="err-msg">⚠ ${esc(t.last_error)}</div>`:'';
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

// ---------- Worker 日志 ----------
async function fetchLogs(){
  if(pauseLog)return;
  try{
    const r = await fetch('/api/logs?since='+logSince);
    const d = await r.json();
    if(d.lines&&d.lines.length>0){
      const body = document.getElementById('logBody');
      const frag = document.createDocumentFragment();
      d.lines.forEach(([id,tm,txt])=>{
        if(!txt.trim())return;
        const div=document.createElement('div');
        div.className='log-line';
        if(/error|traceback|失败|exception/i.test(txt))div.className+=' err';
        else if(/warn|警告/i.test(txt))div.className+=' warn';
        const m=txt.match(/^\[(\w+)\]\s?(.*)/);
        if(m) div.innerHTML=`<span class="t">${tm}</span><span class="tn">[${m[1]}]</span>${esc(m[2])}`;
        else div.innerHTML=`<span class="t">${tm}</span>${esc(txt)}`;
        frag.appendChild(div);
        logSince=id;
      });
      body.appendChild(frag);
      if(autoScroll) body.scrollTop = body.scrollHeight;
      while(body.children.length>1500) body.removeChild(body.firstChild);
    }
  }catch(e){}
}

// ---------- 转码状态 ----------
async function fetchConvertStatus(){
  try{
    const r = await fetch('/api/convert/status');
    const d = await r.json();
    convertStatus = d;
    const running = d.running;
    document.getElementById('btnConvStart').style.display = running?'none':'inline-flex';
    document.getElementById('btnConvStop').style.display = running?'inline-flex':'none';
    document.getElementById('convLogLive').style.background = running?'var(--green)':'var(--muted)';

    const s = d.stats||{};
    document.getElementById('convProgress').innerHTML=`${s.progress||0}<span class="unit">%</span>`;
    document.getElementById('convCount').textContent=`${s.done||0} / ${s.total||0} 专辑`;
    document.getElementById('convOk').innerHTML=`${s.ok||0}<span class="unit">首</span>`;
    document.getElementById('convSkip').innerHTML=`${s.skip||0}<span class="unit">首</span>`;
    document.getElementById('convFail').innerHTML=`${s.fail||0}<span class="unit">首</span>`;
    document.getElementById('convTime').textContent=`用时 ${Math.floor((s.elapsed||0)/60)} 分钟`;
    document.getElementById('convPbar').style.width=(s.progress||0)+'%';
    document.getElementById('convPtext').textContent = running?`正在转码：${s.done||0}/${s.total||0} 专辑`:(s.total>0?'已完成':'等待启动');
    document.getElementById('convPct').textContent=(s.progress||0)+'%';
    if(s.current){
      document.getElementById('convCurrent').style.display='block';
      document.getElementById('convCurrent').textContent='当前处理：'+s.current;
    } else {
      document.getElementById('convCurrent').style.display='none';
    }
  }catch(e){console.error(e)}
}

async function fetchConvertLogs(){
  try{
    const r = await fetch('/api/convert/logs?since='+convLogSince);
    const d = await r.json();
    if(d.lines&&d.lines.length>0){
      const body = document.getElementById('convLogBody');
      const frag = document.createDocumentFragment();
      d.lines.forEach(([id,tm,txt])=>{
        if(!txt.trim())return;
        const div=document.createElement('div');
        div.className='log-line';
        if(/error|traceback|失败|exception/i.test(txt))div.className+=' err';
        else if(/warn|警告/i.test(txt))div.className+=' warn';
        div.innerHTML=`<span class="t">${tm}</span>${esc(txt)}`;
        frag.appendChild(div);
        convLogSince=id;
      });
      body.appendChild(frag);
      if(convAutoScroll) body.scrollTop = body.scrollHeight;
      while(body.children.length>1500) body.removeChild(body.firstChild);
    }
  }catch(e){}
}

// ---------- 操作 ----------
function parseIds(input){
  const ids = new Set();
  String(input).split(/[,，\s]+/).forEach(part=>{
    if(!part.trim())return;
    const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if(m){
      const a=parseInt(m[1]),b=parseInt(m[2]);
      for(let i=Math.min(a,b);i<=Math.max(a,b);i++)ids.add(i);
    } else {
      const n=parseInt(part);
      if(Number.isInteger(n))ids.add(n);
    }
  });
  return [...ids];
}
async function manualEnqueue(){
  const ids = parseIds(document.getElementById('manualIds').value);
  if(ids.length===0){alert('请输入歌曲ID');return;}
  if(!confirm(`确定将 ${ids.length} 首歌入队？`))return;
  const type = document.getElementById('manualType').value;
  const force = document.getElementById('manualForce').value === 'true';
  const r = await fetch('/api/manual/enqueue',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({song_ids:ids,type,force})});
  const d = await r.json();
  document.getElementById('manualResult').innerHTML =
    d.ok ? `✅ 已入队 <b style="color:var(--green)">${d.added||0}</b> 个任务，跳过 <b>${d.skipped||0}</b> 个` : `❌ 失败：${esc(d.error||'')}`;
}
async function manualUploadLyrics(){
  const ids = parseIds(document.getElementById('manualIds').value);
  if(ids.length===0){alert('请输入歌曲ID');return;}
  if(!confirm(`确定上传 ${ids.length} 首歌的歌词到网盘？`))return;
  const r = await fetch('/api/manual/upload-lyrics',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({song_ids:ids})});
  const d = await r.json();
  document.getElementById('manualResult').innerHTML =
    d.ok ? `✅ 已受理上传 <b style="color:var(--green)">${d.uploaded||0}</b> 首，跳过 <b>${d.skipped||0}</b> 首（异步执行中）` : `❌ 失败：${esc(d.error||'')}`;
}
// ---------- 无歌词歌曲预览选择（从KTV获取，勾选后批量入队/上传） ----------
let noLyricsSongs = [];
async function fetchNoLyrics(){
  const info = document.getElementById('noLyricsInfo');
  info.textContent = '正在从KTV获取...';
  try{
    const r = await fetch('/api/ktv/no-lyrics?limit=200');
    const d = await r.json();
    if(!d.ok){ info.textContent = '获取失败: ' + (d.error||'未知错误'); return; }
    noLyricsSongs = d.songs || [];
    info.textContent = '共 ' + d.total + ' 首无逐字歌词，显示 ' + d.count + ' 首（按ID倒序）';
    renderNoLyricsList();
  }catch(e){ info.textContent = '获取失败: ' + e.message; }
}
function renderNoLyricsList(){
  const container = document.getElementById('noLyricsList');
  const items = document.getElementById('noLyricsItems');
  container.style.display = 'block';
  if(noLyricsSongs.length === 0){
    items.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:12px">暂无无逐字歌词的音频歌曲</div>';
    updateNoLyricsSelected();
    return;
  }
  items.innerHTML = noLyricsSongs.map(function(s){
    var ext = (s.filename || '').split('.').pop().toUpperCase();
    var lyricTag = s.has_plain_lyrics
      ? '<span style="font-size:10px;color:var(--teal);background:rgba(13,148,136,.15);padding:2px 6px;border-radius:4px">有纯文本歌词</span>'
      : '<span style="font-size:10px;color:var(--orange);background:rgba(251,146,60,.15);padding:2px 6px;border-radius:4px">无歌词</span>';
    var sepTag = (s.sep_status && s.sep_status !== 'none')
      ? '<span style="font-size:10px;color:var(--green)">分离OK</span>' : '<span style="font-size:10px;color:var(--muted)">未分离</span>';
    return '<label style="display:flex;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px solid var(--border);cursor:pointer;font-size:12px">'
      + '<input type="checkbox" class="no-lyrics-check" data-id="' + s.id + '" onchange="updateNoLyricsSelected()" style="accent-color:var(--teal);flex-shrink:0;width:16px;height:16px">'
      + '<span style="color:var(--muted);font-family:Consolas,monospace;min-width:42px;flex-shrink:0">#' + s.id + '</span>'
      + '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><b>' + esc(s.title||'未知') + '</b> <span style="color:var(--muted)">- ' + esc(s.artist||'未知') + '</span></span>'
      + '<span style="font-size:10px;color:var(--muted);background:var(--bg2);padding:2px 6px;border-radius:4px;flex-shrink:0">' + ext + '</span>'
      + sepTag + lyricTag
      + '</label>';
  }).join('');
  document.getElementById('noLyricsSelectAll').checked = false;
  updateNoLyricsSelected();
}
function toggleSelectAllNoLyrics(checked){
  document.querySelectorAll('.no-lyrics-check').forEach(function(c){ c.checked = checked; });
  updateNoLyricsSelected();
}
function updateNoLyricsSelected(){
  var n = document.querySelectorAll('.no-lyrics-check:checked').length;
  document.getElementById('noLyricsSelected').textContent = '已选 ' + n + ' 首';
}
function getSelectedNoLyricsIds(){
  return [...document.querySelectorAll('.no-lyrics-check:checked')].map(function(c){ return parseInt(c.dataset.id); });
}
async function enqueueSelectedNoLyrics(){
  var ids = getSelectedNoLyricsIds();
  if(ids.length === 0){ alert('请先勾选歌曲'); return; }
  // 将选中ID填入手动输入框，复用现有入队逻辑（含任务类型/强制重做设置）
  document.getElementById('manualIds').value = ids.join(',');
  await manualEnqueue();
}
async function uploadSelectedNoLyrics(){
  var ids = getSelectedNoLyricsIds();
  if(ids.length === 0){ alert('请先勾选歌曲'); return; }
  document.getElementById('manualIds').value = ids.join(',');
  await manualUploadLyrics();
}
async function manualProcessFile(){
  const input = document.getElementById('mpInput').value.trim();
  const output = document.getElementById('mpOutput').value.trim();
  if(!input || !output){alert('请填写源文件路径和输出目录');return;}
  const task = document.getElementById('mpTask').value;
  const upload_back = document.getElementById('mpUploadBack').value === 'true';
  const r = await fetch('/api/manual/process-file',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input_path:input,output_dir:output,task,upload_back})});
  const d = await r.json();
  if(!d.ok) alert(d.msg||d.error);
  fetchManualStatus();
}
async function manualStopFile(){
  await fetch('/api/manual/stop',{method:'POST'});
  fetchManualStatus();
}
async function fetchManualStatus(){
  try{
    const r = await fetch('/api/manual/status');
    const d = await r.json();
    const running = d.running;
    document.getElementById('mpStartBtn').style.display = running?'none':'inline-flex';
    document.getElementById('mpStopBtn').style.display = running?'inline-flex':'none';
    const s = d.current_step||'';
    const pct = d.progress||0;
    const done = d.done_files||0, total = d.total_files||0;
    let html = '';
    if(running){
      html = `📊 总体进度 <b style="color:var(--accent)">${pct}%</b>（${done}/${total}）<br>`;
      if(d.current_file) html += `当前文件: <b style="color:var(--orange)">${esc(d.current_file)}</b><br>`;
      html += `步骤: ${esc(s)} · 用时 ${Math.floor((d.elapsed||0)/60)}分${(d.elapsed||0)%60}秒`;
    } else if(d.error){
      html = `<span style="color:var(--red)">❌ ${esc(d.error)}</span>`;
    } else if(s){
      html = `<span style="color:var(--green)">✅ ${esc(s)}</span>`;
    } else {
      html = '空闲';
    }
    document.getElementById('mpStatus').innerHTML = html;
    const files = d.output_files||[];
    document.getElementById('mpFiles').innerHTML = files.length
      ? '📁 已生成输出文件:<br>' + files.map(f=>esc(f)).join('<br>')
      : '';
  }catch(e){}
}
async function startWorker(){await fetch('/api/start',{method:'POST'});fetchWorkerStatus();}
async function stopWorker(){
  if(!confirm('确定停止 Worker？正在处理的任务会跑完后退出。'))return;
  await fetch('/api/stop',{method:'POST'});fetchWorkerStatus();
}
async function applyThreads(){
  const n=parseInt(document.getElementById('threadSlider').value);
  await fetch('/api/threads',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({threads:n})});
  fetchWorkerStatus();
}
function setQuick(n,btn){
  document.getElementById('threadSlider').value=n;
  document.getElementById('threadVal').textContent=n;
  document.querySelectorAll('.quick-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
}
async function startConvert(){
  const cfg = {
    root: document.getElementById('cfgRoot').value,
    out_root: document.getElementById('cfgOutRoot').value,
    mode: document.getElementById('cfgMode').value,
    workers: parseInt(document.getElementById('cfgWorkers').value)||8,
    only: document.getElementById('cfgOnly').value,
    limit: parseInt(document.getElementById('cfgLimit').value)||0,
    dry: document.getElementById('cfgDry').checked,
  };
  const r = await fetch('/api/convert/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg)});
  const d = await r.json();
  if(!d.ok) alert(d.msg);
  fetchConvertStatus();
}
async function stopConvert(){
  if(!confirm('确定停止转码？正在转换的专辑会被中断。'))return;
  await fetch('/api/convert/stop',{method:'POST'});
  fetchConvertStatus();
}

// 日志控制
function toggleAutoScroll(){autoScroll=!autoScroll;document.getElementById('btnAutoScroll').classList.toggle('active',autoScroll);}
function togglePauseLog(){pauseLog=!pauseLog;document.getElementById('btnPauseLog').textContent=pauseLog?'继续':'暂停';document.getElementById('btnPauseLog').classList.toggle('active',pauseLog);}
function clearLog(){document.getElementById('logBody').innerHTML='';}
function toggleConvAutoScroll(){convAutoScroll=!convAutoScroll;document.getElementById('btnConvAutoScroll').classList.toggle('active',convAutoScroll);}
function clearConvLog(){document.getElementById('convLogBody').innerHTML='';}

// 启动轮询
fetchWorkerStatus();
fetchConvertStatus();
setInterval(fetchWorkerStatus,1500);
setInterval(fetchConvertStatus,1500);
setInterval(fetchManualStatus,1500);
setInterval(fetchLogs,800);
setInterval(fetchConvertLogs,800);
fetchManualStatus();

// ==================== 目录浏览 ====================
let _browserMode = 'file'; // 'file' = 选源文件, 'dir' = 选输出目录
let _browserCurrent = '';
let _browserSelected = [];

async function openBrowser(mode){
  _browserMode = mode;
  _browserSelected = [];
  document.getElementById('browserModal').style.display = 'flex';
  document.getElementById('browserTitle').textContent = mode === 'file' ? '选择源音频文件（可多选）' : '选择输出目录';
  document.getElementById('browserSelectBtn').style.display = mode === 'dir' ? 'inline-block' : 'none';
  document.getElementById('browserHint').textContent = mode === 'file' ? '点击文件添加到列表，点击文件夹进入' : '导航到目标目录后点「选择此目录」';
  await browserLoad('');
}

function closeBrowser(){
  document.getElementById('browserModal').style.display = 'none';
}

async function browserLoad(path){
  _browserCurrent = path;
  document.getElementById('browserPath').textContent = path || '此电脑';
  try{
    const r = await fetch('/api/browse?path=' + encodeURIComponent(path));
    const d = await r.json();
    const list = document.getElementById('browserList');
    let html = '';
    if(d.error){
      html = '<div style="color:var(--red);padding:20px;text-align:center">❌ ' + d.error + '</div>';
    } else {
      for(const item of d.dirs){
        const icon = item.type === 'drive' ? '💽' : '📁';
        html += '<div class="browser-item" data-type="dir" data-path="' + item.path.replace(/"/g,'&quot;') + '" style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:7px;cursor:pointer;font-size:12px;transition:.12s">' +
          '<span style="font-size:15px">' + icon + '</span>' +
          '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + item.name + '</span>' +
          '<span style="color:var(--muted);font-size:10px">文件夹</span>' +
        '</div>';
      }
      for(const f of d.files){
        const selected = _browserSelected.includes(f.path);
        const sizeMB = (f.size / 1048576).toFixed(1);
        html += '<div class="browser-item" data-type="file" data-path="' + f.path.replace(/"/g,'&quot;') + '" style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:7px;cursor:pointer;font-size:12px;transition:.12s;background:' + (selected ? 'rgba(20,184,166,.15)' : 'transparent') + '">' +
          '<span style="font-size:15px">' + (selected ? '✅' : '🎵') + '</span>' +
          '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + f.name + '</span>' +
          '<span style="color:var(--muted);font-size:10px">' + sizeMB + ' MB</span>' +
        '</div>';
      }
      if(!d.dirs.length && !d.files.length){
        html = '<div style="color:var(--muted);padding:30px;text-align:center;font-size:12px">（空目录）</div>';
      }
    }
    list.innerHTML = html;
    // 事件委托：处理点击
    list.querySelectorAll('.browser-item').forEach(el => {
      el.addEventListener('click', function(){
        const p = this.getAttribute('data-path');
        const t = this.getAttribute('data-type');
        if(t === 'dir'){
          browserLoad(p);
        } else {
          browserToggleFile(p);
        }
      });
      el.addEventListener('mouseenter', function(){ this.style.background = 'rgba(255,255,255,.06)'; });
      el.addEventListener('mouseleave', function(){
        const p = this.getAttribute('data-path');
        this.style.background = _browserSelected.includes(p) ? 'rgba(20,184,166,.15)' : 'transparent';
      });
    });
    if(_browserMode === 'file' && _browserSelected.length > 0){
      document.getElementById('browserHint').textContent = '已选 ' + _browserSelected.length + ' 个文件，点「确认添加」';
    }
  }catch(e){
    document.getElementById('browserList').innerHTML = '<div style="color:var(--red);padding:20px">加载失败：' + e.message + '</div>';
  }
}

function browserGoUp(){
  if(!_browserCurrent) return;
  const parent = _browserCurrent.substring(0, _browserCurrent.lastIndexOf('\\'));
  browserLoad(parent || '');
}

function browserToggleFile(path){
  const idx = _browserSelected.indexOf(path);
  if(idx >= 0){
    _browserSelected.splice(idx, 1);
  } else {
    _browserSelected.push(path);
  }
  browserLoad(_browserCurrent);
  const btn = document.getElementById('browserSelectBtn');
  if(_browserMode === 'file'){
    if(_browserSelected.length > 0){
      btn.style.display = 'inline-block';
      btn.textContent = '✅ 确认添加(' + _browserSelected.length + ')';
    } else {
      btn.style.display = 'none';
    }
  }
}

function browserConfirm(){
  if(_browserMode === 'dir'){
    document.getElementById('mpOutput').value = _browserCurrent;
    closeBrowser();
  } else {
    // 文件模式：把已选文件添加到 textarea
    const ta = document.getElementById('mpInput');
    const existing = ta.value.trim();
    const newPaths = _browserSelected.join('\n');
    ta.value = existing ? existing + '\n' + newPaths : newPaths;
    closeBrowser();
  }
}

</script>

<!-- ==================== 目录浏览模态框 ==================== -->
<div id="browserModal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.7);z-index:9999;justify-content:center;align-items:center">
  <div style="background:var(--bg);border:1px solid var(--border);border-radius:14px;width:600px;max-height:80vh;display:flex;flex-direction:column;overflow:hidden">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border)">
      <div style="font-size:14px;font-weight:700" id="browserTitle">选择文件</div>
      <button onclick="closeBrowser()" style="background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer">✕</button>
    </div>
    <div style="padding:10px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px">
      <button class="btn" style="padding:4px 10px;font-size:11px" onclick="browserGoUp()">⬆ 上级</button>
      <span id="browserPath" style="font-size:11px;color:var(--muted);font-family:Consolas,monospace;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
    </div>
    <div id="browserList" style="flex:1;overflow-y:auto;padding:8px 18px"></div>
    <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
      <span id="browserHint" style="font-size:11px;color:var(--muted)"></span>
      <button class="btn btn-start" id="browserSelectBtn" style="display:none;padding:6px 16px;font-size:12px" onclick="browserConfirm()">✅ 选择此目录</button>
    </div>
  </div>
</div>

</body>
</html>
"""


# ============================================================================
# main
# ============================================================================
def main():
    global manager, log_collector, convert_manager

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

    # WorkerManager（人声分离 + 逐字歌词对齐）
    manager = WorkerManager(a.server, a.worker, a.mode, a.python or sys.executable, cap, init_threads)

    # ConvertManager（FLAC 音频转码）
    convert_manager = ConvertManager(a.python or sys.executable, os.path.dirname(os.path.abspath(__file__)))

    # ManualTaskManager（自定义文件手动处理）
    manual_manager = ManualTaskManager()

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

    import socket as _sock
    _probe = _sock.socket(_sock.AF_INET, _sock.SOCK_STREAM); _probe.settimeout(0.5)
    try:
        _port_busy = _probe.connect_ex(('127.0.0.1', int(a.port))) == 0
    finally:
        _probe.close()
    if _port_busy:
        print('[Station] 端口 %s 已有一个工作站在运行，为避免多实例抢同一块 GPU 导致 OOM，本次启动退出。' % a.port)
        sys.exit(0)
    if a.autostart:
        manager.start()

    # 启动 HTTP 服务器
    # 多线程 HTTP 服务器，避免浏览器多标签轮询时单线程阻塞
    ThreadingHTTPServer.allow_reuse_address = False  # Windows 下禁止重复绑定同一端口
    server = ThreadingHTTPServer((a.host, a.port), StationHandler)
    server.daemon_threads = True
    print(f'Web 控制面板已启动: http://localhost:{a.port}')
    print(f'局域网访问: http://<本机IP>:{a.port}')
    print(f'按 Ctrl+C 退出')
    print(f'=' * 60)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n收到退出信号，正在停止...')
        manager.stop()
        if convert_manager:
            convert_manager.stop()
        server.shutdown()
        print('工作站已退出')


if __name__ == '__main__':
    main()
