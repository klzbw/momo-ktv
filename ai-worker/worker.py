# -*- coding: utf-8 -*-
"""
墨墨爱K歌 —— AI 分离/对齐 Worker（跑在带 N 卡的 Windows 工作站，例如 4070TiS）
==============================================================================
职责（自己不做深度学习，只负责"领任务 -> 调脚本 -> 回传"的调度）：
  1) 轮询服务端 /api/separate/jobs/claim 领取一个任务；
  2) 下载该歌曲源音频到本地临时目录；
  3) 调用 sep_once.py（Demucs 人声分离）或 align_once.py（WhisperX 逐字对齐+官方歌词纠错）；
  4) 把产物（vocals.wav 人声 / accompaniment.wav 伴奏 / 逐字歌词）multipart 回传；
  5) 失败上报、继续下一个，7x24 常驻。

用法：
  python worker.py --server http://192.168.3.16:8083 --worker pc-51 --mode both --gui --concurrency 8
  --mode 可选 separate（只分离）/ align（只对齐）/ both（先分离后对齐，默认）
  --gui  启动卡通图形化监控界面
  --concurrency N 并发路数（默认8）
"""
import argparse, os, sys, time, subprocess, tempfile, shutil, urllib.parse, re, threading, queue
import requests

# 子进程(sep_once/align_once)会继承本环境变量：让 Demucs/Whisper/对齐模型默认走 hf-mirror，
# 避免国内直连 HuggingFace 超时导致任务全失败；用户已设置 HF_ENDPOINT 时不覆盖。
os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')

# ── 全局状态队列（worker 线程 -> GUI 线程）──
_status_q = queue.Queue()
_log_lock = threading.Lock()

def log(*a):
    tname = threading.current_thread().name
    msg = ' '.join(str(x) for x in a)
    line = f'{time.strftime("%H:%M:%S")} [{tname}] {msg}'
    with _log_lock:
        print(line, flush=True)
    try: _status_q.put(('log', line))
    except Exception: pass

def emit(event_type, **data):
    data['type'] = event_type
    data['worker'] = threading.current_thread().name
    data['ts'] = time.time()
    try: _status_q.put(('event', data))
    except Exception: pass

class MomoWorker:
    def __init__(self, server, worker, mode, python_exe):
        self.server = server.rstrip('/')
        self.worker = worker
        self.mode = mode
        self.py = python_exe or sys.executable
        self.here = os.path.dirname(os.path.abspath(__file__))
        self.s = requests.Session()
        self.kinds = ['separate', 'align'] if mode == 'both' else [mode]
        self._current_job = None

    def claim(self, kind):
        try:
            r = self.s.get(f'{self.server}/api/separate/jobs/claim',
                           params={'worker': self.worker, 'type': kind}, timeout=20)
            if r.status_code == 204:
                return None
            r.raise_for_status()
            return r.json()
        except Exception as e:
            log('领任务失败(将重试):', e)
            return None

    def progress(self, job_id, p):
        try:
            self.s.post(f'{self.server}/api/separate/jobs/{job_id}/progress', json={'progress': p}, timeout=15)
        except Exception:
            pass

    def fail(self, job_id, err):
        try:
            self.s.post(f'{self.server}/api/separate/jobs/{job_id}/fail', json={'error': str(e := err)[:1000]}, timeout=15)
        except Exception:
            pass

    def download(self, task, base_path):
        url = task['sourceUrl']
        if url.startswith('/'):
            url = self.server + url
        log('下载源音频:', url)
        emit('downloading', url=url)
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

    def run_child(self, script, args, job_id, progress_map):
        cmd = [self.py, os.path.join(self.here, script)] + args
        log('$', ' '.join(cmd))
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding='utf-8', errors='replace', bufsize=1)
        lines = []
        for line in proc.stdout:
            line = line.rstrip()
            lines.append(line)
            if line.startswith('PROGRESS '):
                try:
                    p = int(line.split()[1])
                    self.progress(job_id, p)
                    emit('progress', job_id=job_id, progress=p)
                except Exception: pass
        proc.wait()
        if proc.returncode != 0:
            raise RuntimeError(f'{script} 退出码 {proc.returncode}: ' + '\n'.join(lines[-15:]))

    def handle(self, task):
        job = task['job']; song = task['song']; kind = job['type']; job_id = job['id']
        title = song.get('title', '未知'); artist = song.get('artist', '未知')
        log(f'开始任务 #{job_id} [{kind}] 《{title}》- {artist}')
        emit('task_start', job_id=job_id, kind=kind, title=title, artist=artist)
        self._current_job = job_id
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
                vocal_src = self._separated_vocal(job['songId']) or src
                args = [vocal_src, word]
                # 官方参考歌词：优先用任务下发的；为空则当场向服务端要一次
                ref = (song or {}).get('refLyrics') or ''
                if not ref.strip():
                    ref = self.fetch_ref_lyrics(song['id'])
                    if ref.strip():
                        log(f'补到官方参考歌词 {len(ref)} 字符（本地/在线）')
                if ref.strip():
                    ref_path = os.path.join(tmp, 'ref.lrc')
                    with open(ref_path, 'w', encoding='utf-8') as f:
                        f.write(ref)
                    args.append('large-v3')
                    args.append(ref_path)
                    log(f'附带官方参考歌词 {len(ref)} 字符用于纠错')
                self.run_child('align_once.py', args, job_id, None)
                files = {'wordLrc': ('word.lrc', open(word, 'rb'), 'text/plain')}
            try:
                self.progress(job_id, 95)
                emit('progress', job_id=job_id, progress=95)
                r = self.s.post(f'{self.server}/api/separate/jobs/{job_id}/complete',
                                files=files, timeout=600)
                r.raise_for_status()
                log(f'任务 #{job_id} 完成并回传:', r.json())
                emit('task_done', job_id=job_id, kind=kind)
            finally:
                for _, v in files.items():
                    try: v[1].close()
                    except Exception: pass
        except Exception as e:
            log('任务失败:', e)
            emit('task_fail', job_id=job_id, error=str(e)[:200])
            self.fail(job_id, str(e))
        finally:
            self._current_job = None
            shutil.rmtree(tmp, ignore_errors=True)

    def _separated_vocal(self, song_id):
        return None

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
        log(f'Worker 启动 server={self.server} name={self.worker} mode={self.mode}')
        emit('worker_start')
        idle_round = 0
        while True:
            got = False
            for kind in self.kinds:
                task = self.claim(kind)
                if task:
                    got = True; idle_round = 0
                    self.handle(task)
                    break
            if not got:
                idle_round += 1
                if idle_round == 1:
                    emit('idle')
                time.sleep(3)
                if idle_round % 20 == 1:
                    log('队列空闲，等待新任务...')

# ══════════════════════════════════════════════════════════════
#  卡通风格图形化界面
# ══════════════════════════════════════════════════════════════
def _round_rect(canvas, x1, y1, x2, y2, r, **kw):
    points = [x1+r, y1, x2-r, y1, x2, y1, x2, y1+r, x2, y2-r, x2, y2,
              x2-r, y2, x1+r, y2, x1, y2, x1, y2-r, x1, y1+r, x1, y1]
    return canvas.create_polygon(points, smooth=True, **kw)

def _run_gui(server, worker_prefix, mode, python_exe, concurrency):
    import tkinter as tk
    from tkinter import ttk

    BG_TOP    = '#ffecd2'
    BG_BOT    = '#fcb69f'
    BG_MAIN   = '#fff5f0'
    CARD      = '#ffffff'
    BORDER    = '#ffd9c0'
    TEXT      = '#4a3f35'
    TEXT_DIM  = '#a89888'
    PINK      = '#ff6b9d'
    TEAL      = '#4ecdc4'
    YELLOW    = '#ffd93d'
    ORANGE    = '#ff9f43'
    PURPLE    = '#a29bfe'
    GREEN     = '#6bcb77'
    RED       = '#ff6b6b'
    BLUE      = '#74b9ff'

    ICONS = ['🎵', '🎤', '🎧', '🎹', '🎸', '🥁', '🎺', '🎻', '🎷', '🪗', '🎼', '🪕']

    workers_state = {}
    stats = {'done': 0, 'fail': 0}

    root = tk.Tk()
    root.title('🎵 墨墨爱K歌 · AI分离工作站')
    root.configure(bg=BG_MAIN)
    root.geometry('1180x820')
    root.minsize(960, 700)

    header_h = 90
    header = tk.Canvas(root, height=header_h, bg=BG_TOP, highlightthickness=0)
    header.pack(fill='x')
    for i in range(header_h):
        ratio = i / header_h
        r = int(0xff + (0xfc - 0xff) * ratio)
        g = int(0xec + (0xb6 - 0xec) * ratio)
        b = int(0xd2 + (0x9f - 0xd2) * ratio)
        header.create_line(0, i, 1200, i, fill=f'#{r:02x}{g:02x}{b:02x}')
    header.create_text(30, 28, text='🎵 墨墨爱K歌', anchor='w',
                       font=('Microsoft YaHei UI', 22, 'bold'), fill='#fff')
    header.create_text(30, 62, text='AI 人声分离 · 逐字歌词对齐 · 官方歌词纠错', anchor='w',
                       font=('Microsoft YaHei UI', 11), fill='#fff5f0')
    header.create_text(1150, 35, text=f'📡 {server}', anchor='e',
                       font=('Microsoft YaHei UI', 9), fill='#fff5f0')
    header.create_text(1150, 60, text=f'⚡ {concurrency} 路并发  |  🎯 {mode}', anchor='e',
                       font=('Microsoft YaHei UI', 9), fill='#fff5f0')

    stats_frame = tk.Frame(root, bg=BG_MAIN)
    stats_frame.pack(fill='x', padx=20, pady=14)

    def make_stat_card(parent, emoji, label, color, col):
        card = tk.Frame(parent, bg=CARD, highlightbackground=BORDER, highlightthickness=2)
        card.grid(row=0, column=col, padx=7, sticky='nsew', ipady=6)
        parent.grid_columnconfigure(col, weight=1)
        bar = tk.Frame(card, bg=color, height=4)
        bar.pack(fill='x')
        row = tk.Frame(card, bg=CARD)
        row.pack(fill='x', padx=14, pady=(8, 2))
        tk.Label(row, text=emoji, bg=CARD, font=('Segoe UI Emoji', 20)).pack(side='left')
        lbl = tk.Label(row, text='0', bg=CARD, fg=color, font=('Consolas', 26, 'bold'))
        lbl.pack(side='left', padx=(8, 0))
        tk.Label(card, text=label, bg=CARD, fg=TEXT_DIM, font=('Microsoft YaHei UI', 9)).pack(anchor='w', padx=14, pady=(0, 8))
        return lbl

    lbl_done = make_stat_card(stats_frame, '✅', '已完成', GREEN, 0)
    lbl_fail = make_stat_card(stats_frame, '❌', '失败', RED, 1)
    lbl_run  = make_stat_card(stats_frame, '🔥', '处理中', ORANGE, 2)
    lbl_gpu  = make_stat_card(stats_frame, '🎮', 'GPU 利用率', BLUE, 3)
    lbl_vram = make_stat_card(stats_frame, '💾', '显存占用', PURPLE, 4)

    prog_wrap = tk.Frame(root, bg=CARD, highlightbackground=BORDER, highlightthickness=2)
    prog_wrap.pack(fill='x', padx=20, pady=(0, 10))
    tk.Label(prog_wrap, text='🌟 总体进度', bg=CARD, fg=TEXT, font=('Microsoft YaHei UI', 10, 'bold')).pack(anchor='w', padx=16, pady=(10, 4))
    pb_canvas = tk.Canvas(prog_wrap, height=26, bg='#fff0e6', highlightthickness=0)
    pb_canvas.pack(fill='x', padx=16, pady=(0, 4))
    pb_fill = _round_rect(pb_canvas, 2, 2, 2, 24, 10, fill=GREEN, outline='')
    pb_text = pb_canvas.create_text(6, 13, text='0%', anchor='w', font=('Consolas', 10, 'bold'), fill='#fff')
    lbl_prog_info = tk.Label(prog_wrap, text='准备就绪~', bg=CARD, fg=TEXT_DIM, font=('Microsoft YaHei UI', 9))
    lbl_prog_info.pack(anchor='e', padx=16, pady=(0, 10))

    outer = tk.Frame(root, bg=BG_MAIN)
    outer.pack(fill='both', expand=True, padx=20, pady=(0, 8))
    canvas = tk.Canvas(outer, bg=BG_MAIN, highlightthickness=0)
    scrollbar = ttk.Scrollbar(outer, orient='vertical', command=canvas.yview)
    cards_inner = tk.Frame(canvas, bg=BG_MAIN)
    cards_inner.bind('<Configure>', lambda e: canvas.configure(scrollregion=canvas.bbox('all')))
    canvas.create_window((0, 0), window=cards_inner, anchor='nw')
    canvas.configure(yscrollcommand=scrollbar.set)
    canvas.pack(side='left', fill='both', expand=True)
    scrollbar.pack(side='right', fill='y')
    def _on_mousewheel(event):
        canvas.yview_scroll(int(-1 * (event.delta / 120)), 'units')
    canvas.bind_all('<MouseWheel>', _on_mousewheel)

    worker_cards = {}
    cols = 4
    for i in range(concurrency):
        wname = f'{worker_prefix}-{i+1}'
        row, col = divmod(i, cols)
        icon = ICONS[i % len(ICONS)]
        card = tk.Frame(cards_inner, bg=CARD, highlightbackground=BORDER, highlightthickness=2)
        card.grid(row=row, column=col, padx=7, pady=7, sticky='nsew', ipady=4)
        cards_inner.grid_columnconfigure(col, weight=1)
        top_bar = tk.Frame(card, bg=PINK, height=3)
        top_bar.pack(fill='x')
        head = tk.Frame(card, bg=CARD)
        head.pack(fill='x', padx=10, pady=(8, 2))
        tk.Label(head, text=icon, bg=CARD, font=('Segoe UI Emoji', 18)).pack(side='left')
        tk.Label(head, text=wname, bg=CARD, fg=TEXT, font=('Microsoft YaHei UI', 10, 'bold')).pack(side='left', padx=(6, 0))
        tag = tk.Label(head, text='待命中', bg='#f0f0f0', fg=TEXT_DIM, font=('Microsoft YaHei UI', 8), padx=8, pady=2)
        tag.pack(side='right')
        song_lbl = tk.Label(card, text='✨ 等待任务~', bg=CARD, fg=TEXT_DIM,
                            font=('Microsoft YaHei UI', 9), anchor='w', justify='left', wraplength=220)
        song_lbl.pack(fill='x', padx=10, pady=(6, 4))
        pb_c = tk.Canvas(card, height=18, bg='#fff0e6', highlightthickness=0)
        pb_c.pack(fill='x', padx=10, pady=(0, 2))
        fill_id = _round_rect(pb_c, 1, 1, 1, 16, 7, fill=GREEN, outline='')
        pct_id = pb_c.create_text(6, 9, text='0%', anchor='w', font=('Consolas', 8, 'bold'), fill='#fff')
        foot = tk.Frame(card, bg=CARD)
        foot.pack(fill='x', padx=10, pady=(0, 8))
        time_lbl = tk.Label(foot, text='', bg=CARD, fg=TEXT_DIM, font=('Consolas', 8))
        time_lbl.pack(side='right')
        worker_cards[wname] = {
            'card': card, 'top_bar': top_bar, 'tag': tag, 'song_lbl': song_lbl,
            'pb_c': pb_c, 'fill_id': fill_id, 'pct_id': pct_id, 'time_lbl': time_lbl,
            'start_time': None, 'icon': icon,
        }
        workers_state[wname] = {'status': 'idle', 'title': '', 'progress': 0, 'kind': ''}

    log_wrap = tk.Frame(root, bg=CARD, highlightbackground=BORDER, highlightthickness=2)
    log_wrap.pack(fill='x', padx=20, pady=(0, 12))
    tk.Label(log_wrap, text='📋 实时日志', bg=CARD, fg=TEXT, font=('Microsoft YaHei UI', 10, 'bold')).pack(anchor='w', padx=14, pady=(8, 2))
    log_text = tk.Text(log_wrap, height=5, bg='#fffaf5', fg=TEXT, font=('Consolas', 8),
                       insertbackground=TEXT, relief='flat', wrap='word')
    log_text.pack(fill='x', padx=14, pady=(0, 8))
    log_scroll = ttk.Scrollbar(log_text, command=log_text.yview)
    log_text.configure(yscrollcommand=log_scroll.set)
    log_scroll.pack(side='right', fill='y')
    log_text.configure(state='disabled')

    def append_log(line):
        log_text.configure(state='normal')
        log_text.insert('end', line + '\n')
        log_text.see('end')
        lines = int(log_text.index('end-1c').split('.')[0])
        if lines > 300:
            log_text.delete('1.0', f'{lines-250}.0')
        log_text.configure(state='disabled')

    gpu_info = {'util': '—', 'vram': '—'}
    def gpu_monitor():
        while True:
            try:
                r = subprocess.run(['nvidia-smi', '--query-gpu=utilization.gpu,memory.used,memory.total',
                                    '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=5)
                parts = [x.strip() for x in r.stdout.strip().split(',')]
                if len(parts) >= 3:
                    gpu_info['util'] = f'{int(parts[0])}%'
                    gpu_info['vram'] = f'{int(parts[1])}/{int(parts[2])}'
            except Exception:
                pass
            time.sleep(2)
    threading.Thread(target=gpu_monitor, daemon=True).start()

    def update_pb(pb_c, fill_id, pct_id, pct, color):
        w = pb_c.winfo_width()
        if w < 10: w = 200
        fill_w = max(2, int(w * pct / 100) - 2)
        pb_c.coords(fill_id, 1, 1, 1 + fill_w, 16)
        pb_c.itemconfig(fill_id, fill=color)
        pb_c.coords(pct_id, min(6 + fill_w - 30, w - 35), 9)
        pb_c.itemconfig(pct_id, text=f'{pct}%')

    def process_event(data):
        wname = data.get('worker', '')
        if wname not in worker_cards:
            return
        c = worker_cards[wname]
        st = workers_state[wname]
        etype = data['type']

        if etype in ('worker_start', 'idle'):
            c['top_bar'].configure(bg='#e0e0e0')
            c['tag'].configure(text='😴 待命中', bg='#f0f0f0', fg=TEXT_DIM)
            c['song_lbl'].configure(text='✨ 等待任务~', fg=TEXT_DIM)
            update_pb(c['pb_c'], c['fill_id'], c['pct_id'], 0, '#e0e0e0')
            c['time_lbl'].configure(text='')
            st['status'] = 'idle'; st['title'] = ''; st['progress'] = 0
            c['start_time'] = None

        elif etype == 'downloading':
            c['top_bar'].configure(bg=BLUE)
            c['tag'].configure(text='📥 下载中', bg='#e3f2fd', fg=BLUE)
            st['status'] = 'downloading'

        elif etype == 'task_start':
            kind = data.get('kind', '')
            if kind == 'separate':
                color = ORANGE; tag_text = '🎤 人声分离'; bg = '#fff3e0'
            else:
                color = PURPLE; tag_text = '📝 逐字对齐'; bg = '#f3e5f5'
            c['top_bar'].configure(bg=color)
            c['tag'].configure(text=tag_text, bg=bg, fg=color)
            title = data.get('title', ''); artist = data.get('artist', '')
            display = f'《{title}》\n{artist}' if artist else f'《{title}》'
            c['song_lbl'].configure(text=display, fg=TEXT)
            update_pb(c['pb_c'], c['fill_id'], c['pct_id'], 5, color)
            c['start_time'] = time.time()
            st['status'] = 'running'; st['title'] = title; st['kind'] = kind; st['progress'] = 5

        elif etype == 'progress':
            p = max(0, min(100, int(data.get('progress', 0))))
            color = ORANGE if st.get('kind') == 'separate' else PURPLE
            update_pb(c['pb_c'], c['fill_id'], c['pct_id'], p, color)
            st['progress'] = p
            if c['start_time']:
                elapsed = int(time.time() - c['start_time'])
                c['time_lbl'].configure(text=f'⏱ {elapsed//60:02d}:{elapsed%60:02d}')

        elif etype == 'task_done':
            c['top_bar'].configure(bg=GREEN)
            c['tag'].configure(text='🎉 完成!', bg='#e8f5e9', fg=GREEN)
            update_pb(c['pb_c'], c['fill_id'], c['pct_id'], 100, GREEN)
            stats['done'] += 1
            st['status'] = 'done'
            root.after(2000, lambda w=wname: _reset_to_idle(w))

        elif etype == 'task_fail':
            c['top_bar'].configure(bg=RED)
            c['tag'].configure(text='💔 失败', bg='#ffebee', fg=RED)
            update_pb(c['pb_c'], c['fill_id'], c['pct_id'], 100, RED)
            stats['fail'] += 1
            st['status'] = 'fail'
            root.after(3000, lambda w=wname: _reset_to_idle(w))

    def _reset_to_idle(wname):
        if wname in worker_cards:
            c = worker_cards[wname]
            c['top_bar'].configure(bg='#e0e0e0')

    def update_stats_ui():
        lbl_done.configure(text=str(stats['done']))
        lbl_fail.configure(text=str(stats['fail']))
        running = sum(1 for s in workers_state.values() if s['status'] in ('running', 'downloading'))
        lbl_run.configure(text=str(running))
        lbl_gpu.configure(text=gpu_info['util'])
        lbl_vram.configure(text=gpu_info['vram'])
        total = stats['done'] + stats['fail'] + running
        if total > 0:
            pct = int(stats['done'] / total * 100)
        else:
            pct = 0
        w = pb_canvas.winfo_width()
        if w < 10: w = 800
        fill_w = max(2, int(w * pct / 100) - 4)
        pb_canvas.coords(pb_fill, 2, 2, 2 + fill_w, 24)
        pb_canvas.coords(pb_text, min(10 + fill_w, w - 50), 13)
        pb_canvas.itemconfig(pb_text, text=f'{pct}%')
        lbl_prog_info.configure(text=f'✅ {stats["done"]} 完成  |  🔥 {running} 处理中  |  ❌ {stats["fail"]} 失败')

    def pump():
        try:
            while True:
                kind, payload = _status_q.get_nowait()
                if kind == 'log':
                    append_log(payload)
                elif kind == 'event':
                    process_event(payload)
        except queue.Empty:
            pass
        update_stats_ui()
        root.after(150, pump)
    root.after(150, pump)

    def start_workers():
        time.sleep(0.3)
        for i in range(concurrency):
            tname = f'{worker_prefix}-{i+1}'
            t = threading.Thread(target=MomoWorker(server, tname, mode, python_exe).loop,
                                 name=tname, daemon=True)
            t.start()
            time.sleep(0.25)
    threading.Thread(target=start_workers, daemon=True).start()

    root.mainloop()

# ══════════════════════════════════════════════════════════════
#  入口
# ══════════════════════════════════════════════════════════════
def _worker_thread(server, worker_name, mode, python_exe):
    MomoWorker(server, worker_name, mode, python_exe).loop()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--server', default=os.environ.get('MOMO_SERVER', 'http://192.168.3.16:8083'))
    ap.add_argument('--worker', default=os.environ.get('MOMO_WORKER', 'pc-gpu'))
    ap.add_argument('--mode', default='both', choices=['separate', 'align', 'both'])
    ap.add_argument('--python', default='', help='子进程用的 python（默认与本进程一致）')
    ap.add_argument('--concurrency', type=int, default=8, help='并发路数（默认8）')
    ap.add_argument('--gui', action='store_true', help='启动图形化监控界面')
    a = ap.parse_args()
    n = max(1, a.concurrency)

    if a.gui:
        _run_gui(a.server, a.worker, a.mode, a.python or None, n)
        return

    if n == 1:
        MomoWorker(a.server, a.worker, a.mode, a.python).loop()
    else:
        log(f'启动 {n} 路并发 worker，前缀={a.worker}')
        threads = []
        for i in range(n):
            tname = f'{a.worker}-{i+1}'
            t = threading.Thread(target=_worker_thread, args=(a.server, tname, a.mode, a.python), name=tname, daemon=True)
            t.start()
            threads.append(t)
            time.sleep(0.5)
        try:
            for t in threads:
                t.join()
        except KeyboardInterrupt:
            log('收到中断信号，正在停止...')
            sys.exit(0)

if __name__ == '__main__':
    main()
