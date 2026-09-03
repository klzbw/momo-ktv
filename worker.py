# -*- coding: utf-8 -*-
"""
墨墨爱K歌 —— AI 分离/对齐 Worker（跑在带 N 卡的 Windows 工作站，例如 4070TiS）
==============================================================================
职责（自己不做深度学习，只负责"领任务 -> 调脚本 -> 回传"的调度）：
  1) 轮询服务端 /api/separate/jobs/claim 领取一个任务；
  2) 下载该歌曲源音频到本地临时目录；
  3) 调用 sep_once.py（Demucs 人声分离）或 align_once.py（WhisperX 逐字对齐）；
  4) 把产物（vocals.wav 人声 / accompaniment.wav 伴奏 / 逐字歌词）multipart 回传；
  5) 失败上报、继续下一个，7x24 常驻。

为什么把"重活"拆到 sep_once.py / align_once.py 子进程？
  torch/CUDA、模型在一个进程里反复跑很多首容易显存碎片/泄漏；每首歌起一个独立
  子进程、跑完进程退出、显存彻底释放，是最稳的工程做法，也方便单独调试某一首。

用法：
  python worker.py --server http://192.168.3.16:8083 --worker pc-51 --mode both
  --mode 可选 separate（只分离）/ align（只对齐）/ both（先分离后对齐，默认）
"""
import argparse, os, sys, time, subprocess, tempfile, shutil, urllib.parse, re, json, threading
import requests

# Windows GBK控制台无法输出部分Unicode字符(如子进程错误里的\ufffd)，强制UTF-8避免log时主进程崩溃
if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

# 子进程(sep_once/align_once)会继承本环境变量：让 Demucs/Whisper/对齐模型默认走 hf-mirror，
# 避免国内直连 HuggingFace 超时导致任务全失败；用户已设置 HF_ENDPOINT 时不覆盖。
os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')

def log(*a):
    tname = threading.current_thread().name
    prefix = f'[{tname}]' if tname != 'MainThread' else ''
    print(time.strftime('%H:%M:%S'), prefix, *a, flush=True)

class MomoWorker:
    def __init__(self, server, worker, mode, python_exe, capability=None):
        self.server = server.rstrip('/')
        self.worker = worker
        self.mode = mode
        self.py = python_exe or sys.executable
        self.here = os.path.dirname(os.path.abspath(__file__))
        self.s = requests.Session()
        # 算力等级：'gpu'(N卡CUDA) 或 'cpu'。由 entrypoint 探测后通过 MOMO_CAPABILITY
        # 传入；服务端据此做"有GPU优先给GPU、GPU空闲超时才让CPU兜底"的双模调度。
        self.capability = capability or os.environ.get('MOMO_CAPABILITY', 'cpu')
        if self.capability not in ('gpu', 'cpu'):
            self.capability = 'cpu'
        # 两种任务的领取顺序；both 时每轮优先 separate，没有再 align
        self.kinds = ['separate', 'align'] if mode == 'both' else [mode]
        # 优雅退出：stop_event 置位后，当前任务跑完即退出线程（供工作站动态增减线程）
        self.stop_event = threading.Event()
        # 当前任务状态（供 GUI 监控）：None=空闲，dict=正在处理的任务信息
        self.current_job = None
        self.last_error = None
        self.done_count = 0
        self.fail_count = 0

    # 领任务；没有任务返回 None
    def claim(self, kind):
        try:
            r = self.s.get(f'{self.server}/api/separate/jobs/claim',
                           params={'worker': self.worker, 'type': kind,
                                   'capability': self.capability}, timeout=20)
            if r.status_code == 204:
                return None
            r.raise_for_status()
            return r.json()
        except Exception as e:
            log('领任务失败(将重试):', e)
            return None

    def progress(self, job_id, p):
        try:
            self.s.post(f'{self.server}/api/separate/jobs/{job_id}/progress',
                        json={'progress': p, 'worker': self.worker,
                              'capability': self.capability}, timeout=15)
        except Exception:
            pass

    def fail(self, job_id, err):
        try:
            self.s.post(f'{self.server}/api/separate/jobs/{job_id}/fail', json={'error': str(e := err)[:1000]}, timeout=15)
        except Exception:
            pass

    # 下载源音频，返回本地路径（从 Content-Disposition 解析真实扩展名，Demucs 靠后缀识别格式）
    def download(self, task, base_path):
        url = task['sourceUrl']
        if url.startswith('/'):
            url = self.server + url
        log('下载源音频:', url)
        with self.s.get(url, stream=True, timeout=300) as r:
            r.raise_for_status()
            ext = ''
            cd = r.headers.get('Content-Disposition', '')
            m = re.search(r'filename="?([^";]+)"?', cd)
            if m:
                ext = os.path.splitext(urllib.parse.unquote(m.group(1)))[1]
            if not ext:
                ext = '.wav' if task.get('song', {}).get('mediaType') == 'cue' else '.audio'
            dst = os.path.join(os.path.dirname(base_path), 'source' + ext)
            with open(dst, 'wb') as f:
                for chunk in r.iter_content(1 << 20):
                    f.write(chunk)
        return dst

    # 调子进程脚本，实时把进度回传
    def run_child(self, script, args, job_id, progress_map):
        cmd = [self.py, os.path.join(self.here, script)] + args
        log('$', ' '.join(cmd))
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding='utf-8', errors='replace', bufsize=1)
        lines = []
        for line in proc.stdout:
            line = line.rstrip()
            lines.append(line)
            print('   |', line, flush=True)
            # 子进程打印 PROGRESS 35 这样的行 -> 回传进度 + 更新本地状态供 GUI
            if line.startswith('PROGRESS '):
                try:
                    p = int(line.split()[1])
                    self.progress(job_id, p)
                    if self.current_job: self.current_job['progress'] = p
                except Exception: pass
        proc.wait()
        if proc.returncode != 0:
            raise RuntimeError(f'{script} 退出码 {proc.returncode}: ' + '\n'.join(lines[-15:]))

    def handle(self, task):
        job = task['job']; song = task['song']; kind = job['type']; job_id = job['id']
        self.current_job = {'id': job_id, 'type': kind, 'title': song.get('title'),
                            'artist': song.get('artist'), 'progress': 0, 'start': time.time()}
        log(f'开始任务 #{job_id} [{kind}] 《{song.get("title")}》- {song.get("artist")}')
        tmp = tempfile.mkdtemp(prefix=f'momo_{kind}_{job_id}_')
        try:
            src = self.download(task, os.path.join(tmp, 'source'))
            files = {}
            if kind == 'separate':
                vocals = os.path.join(tmp, 'vocals.wav'); accomp = os.path.join(tmp, 'accompaniment.wav')
                self.run_child('sep_once.py', [src, vocals, accomp], job_id, None)
                files = {'vocals': ('vocals.wav', open(vocals, 'rb'), 'audio/wav'),
                         'accompaniment': ('accompaniment.wav', open(accomp, 'rb'), 'audio/wav')}
            else:
                word = os.path.join(tmp, 'word.lrc')
                # 对齐优先用分离出的纯人声（更准）；没有就用源音频
                vocal_src = self._separated_vocal(job['songId']) or src
                args = [vocal_src, word]
                # 官方参考歌词：优先用任务下发的；为空则当场向服务端要一次（本地同名lrc优先，
                # 缺则在线网易云/QQ/酷我三源补抓并入库），尽量让每首都能"官方文字+精准时间"
                ref = (song or {}).get('refLyrics') or ''
                if not ref.strip():
                    ref = self.fetch_ref_lyrics(song['id'])
                    if ref.strip():
                        log(f'补到官方参考歌词 {len(ref)} 字符（本地/在线）')
                # 官方参考歌词（本地同名lrc/三源刮削已入库）：传给对齐子进程做逐字纠错
                if ref.strip():
                    ref_path = os.path.join(tmp, 'ref.lrc')
                    with open(ref_path, 'w', encoding='utf-8') as f:
                        f.write(ref)
                    args.append('large-v3')   # 第3位是模型名，第4位才是参考歌词路径
                    args.append(ref_path)
                    log(f'附带官方参考歌词 {len(ref)} 字符用于纠错')
                self.run_child('align_once.py', args, job_id, None)
                files = {'wordLrc': ('word.lrc', open(word, 'rb'), 'text/plain')}
            try:
                self.progress(job_id, 95)
                if self.current_job: self.current_job['progress'] = 95
                r = self.s.post(f'{self.server}/api/separate/jobs/{job_id}/complete',
                                files=files, timeout=600)
                r.raise_for_status()
                log(f'任务 #{job_id} 完成并回传:', r.json())
                self.done_count += 1
            finally:
                for _, v in files.items():
                    try: v[1].close()
                    except Exception: pass
        except Exception as e:
            log('任务失败:', e)
            self.last_error = str(e)[:200]
            self.fail_count += 1
            self.fail(job_id, str(e))
        finally:
            self.current_job = None
            shutil.rmtree(tmp, ignore_errors=True)

    def _ext(self, task):
        return '.wav'

    # 若这首歌已分离，直接取服务端产物（对齐用纯人声更准）。没有返回 None。
    def _separated_vocal(self, song_id):
        return None  # 简化：对齐直接用源；后续可扩展下载 /data/separated 下的人声

    # 对齐前向服务端要"官方歌词"：本地同名 lrc 优先，缺则在线三源补抓并入库。失败返回''。
    def fetch_ref_lyrics(self, song_id):
        try:
            r = self.s.get(f'{self.server}/api/songs/{song_id}/lyrics',
                           params={'online': 1}, timeout=30)
            if r.status_code == 200:
                return r.json().get('lyrics') or ''
            log('取官方参考歌词 HTTP', r.status_code)
        except Exception as e:
            log('取官方参考歌词失败(继续纯识别):', e)
        return ''

    def loop(self):
        log(f'Worker 启动 server={self.server} name={self.worker} mode={self.mode} capability={self.capability}')
        idle_round = 0
        rr = 0  # round-robin: 轮流从 separate/align 开始，避免分离任务多时对齐被饿死
        while not self.stop_event.is_set():
            got = False
            n = len(self.kinds)
            for i in range(n):
                if self.stop_event.is_set():
                    break
                kind = self.kinds[(rr + i) % n]
                task = self.claim(kind)
                if task:
                    got = True; idle_round = 0
                    self.handle(task)
                    rr += 1  # 下轮从另一种任务开始，保证 separate/align 交替执行
                    break
            if not got and not self.stop_event.is_set():
                idle_round += 1
                self.stop_event.wait(3)  # 可被 stop_event 打断的睡眠
                if idle_round % 20 == 1:
                    log('队列空闲，等待新任务...')
        log('Worker 线程已退出')

    def stop(self):
        """请求线程优雅退出（当前任务跑完即停）"""
        self.stop_event.set()

def load_config():
    """从 worker_config.json 加载配置（图形化界面生成的配置文件）"""
    config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'worker_config.json')
    if os.path.exists(config_path):
        try:
            with open(config_path, 'r', encoding='utf-8') as f:
                cfg = json.load(f)
            log('已加载 worker_config.json 配置')
            return cfg
        except Exception as e:
            log(f'读取 worker_config.json 失败: {e}，使用命令行参数')
    return {}

def main():
    # 先尝试从配置文件加载
    cfg = load_config()

    ap = argparse.ArgumentParser()
    ap.add_argument('--server', default=cfg.get('server_url', os.environ.get('MOMO_SERVER', 'http://192.168.3.16:8083')))
    ap.add_argument('--worker', default=cfg.get('worker_name', os.environ.get('MOMO_WORKER', 'pc-gpu')))
    ap.add_argument('--mode', default=cfg.get('mode', 'both'), choices=['separate', 'align', 'both'])
    ap.add_argument('--python', default=cfg.get('python_exe', ''), help='子进程用的 python（默认与本进程一致）')
    ap.add_argument('--capability', default=cfg.get('capability', os.environ.get('MOMO_CAPABILITY', '')),
                    choices=['', 'gpu', 'cpu'], help='算力等级 gpu/cpu，容器 entrypoint 会自动探测')
    ap.add_argument('--threads', type=int, default=cfg.get('threads', 0),
                    help='并发工作线程数（0=自动：GPU模式默认2，CPU模式默认4）')
    a = ap.parse_args()

    # 把配置传给子进程（通过环境变量）
    if cfg.get('device'):
        os.environ['MOMO_DEVICE'] = cfg['device']
    if cfg.get('demucs_model'):
        os.environ['MOMO_DEMUCS_MODEL'] = cfg['demucs_model']
    if cfg.get('whisper_model'):
        os.environ['MOMO_WHISPER_MODEL'] = cfg['whisper_model']
    if cfg.get('batch_size'):
        os.environ['MOMO_BATCH_SIZE'] = str(cfg['batch_size'])

    # 并发线程数：自动判断或用户指定
    cap = (a.capability or '').lower()
    threads = a.threads if a.threads and a.threads > 0 else (2 if cap == 'gpu' else 4)
    threads = max(1, threads)

    log(f'服务器: {a.server}')
    log(f'Worker: {a.worker}')
    log(f'模式: {a.mode}')
    log(f'算力: {cap or "cpu"}')
    log(f'并发线程数: {threads}' + ('（GPU 模式建议 2~3，过多可能显存不足 OOM）' if cap == 'gpu' and threads > 2 else ''))

    # 多线程：每个线程独立 MomoWorker 实例（独立 requests.Session），各自领任务/调子进程/回传
    # 子进程 sep_once.py / align_once.py 每首歌跑完即退，显存彻底释放，多线程只是让多首同时跑
    ts = []
    for i in range(threads):
        tname = f'W{i+1}'
        w = MomoWorker(a.server, a.worker, a.mode, a.python, a.capability or None)
        t = threading.Thread(target=w.loop, name=tname, daemon=True)
        t.start()
        ts.append((t, w))
        time.sleep(0.3)  # 错开启动，避免同时抢任务/峰值显存
    try:
        while any(t.is_alive() for t, _ in ts):
            time.sleep(1)
    except KeyboardInterrupt:
        log('收到 Ctrl+C，通知各线程停止（当前任务跑完即退出）...')
        for _, w in ts:
            w.stop()
        for t, _ in ts:
            t.join(timeout=30)
        log('所有线程已退出')

if __name__ == '__main__':
    main()
