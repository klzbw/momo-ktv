# -*- coding: utf-8 -*-
"""
detect_instrumental.py —— 纯音乐/无人声 音频检测（Whisper 人声复核）
================================================================================
用途：
  当 flac_convert.py 的关键词规则无法确定某首歌是否为纯音乐时（如歌名/歌手不含
  乐器关键词，但实际是纯音乐），用本脚本跑一遍 Whisper 快速转写，根据是否识别出
  人声来判定。判定为纯音乐的文件可直接写入 INSTRUMENTAL=1 metadata，后续 worker
  自动跳过人声分离和歌词对齐。

原理：
  用 faster-whisper（CTranslate2 加速，比原版 Whisper 快 4 倍）只转写音频前 N 秒
  （默认 30 秒，足够判断是否有人声）。转写结果为空 / 平均对数概率极低 / 只有语气词
  → 判定为纯音乐（无人声）。

用法：
  # 扫描目录，输出检测报告（不修改文件）
  python detect_instrumental.py --root M:\\music\\all-flacs --report detect_report.jsonl

  # 只检测前30秒（默认），用 small 模型（平衡速度/精度）
  python detect_instrumental.py --root M:\\music\\all-flacs --model small --duration 30

  # 检测后直接给纯音乐文件写入 INSTRUMENTAL=1 metadata
  python detect_instrumental.py --root M:\\music\\all-flacs --write-tag

  # 只检测指定文件
  python detect_instrumental.py --file "某首歌.flac"

  # 只检测关键词规则拿不准的（语种=国语但疑似纯音乐）
  python detect_instrumental.py --root M:\\music\\all-flacs --only-uncertain

输出报告格式（JSONL，每行一个文件）：
  {"file": "路径", "instrumental": true/false, "reason": "无人声/转写为空",
   "text": "转写结果前100字", "avg_logprob": -0.5, "duration": 30.0}
"""
import argparse, os, sys, json, time, subprocess, re

if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')

AUDIO_EXTS = ('.flac', '.wav', '.ape', '.mp3', '.m4a', '.ogg', '.tta', '.wv')

# 无意义转写结果（语气词、音乐声、环境声）→ 视为无人声
MEANINGLESS_RE = re.compile(
    r'^[\s\W]*([嗯啊哦唉诶唔哼哈呀哇啦嘛呢吧啊~～\.\,\!\?\…\-—]+|'
    r'(music|melody|instrumental|piano|violin|guitar|drum|bass|'
    r'symphony|orchestra|classical|jazz|blues|folk|new age|ambient|'
    r'soundtrack|score|theme|sonata|concerto|symphony|piece|movement)'
    r'[\s\W]*)$',
    re.IGNORECASE)

def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)

def get_audio_duration(filepath):
    """用 ffprobe 获取音频时长（秒）。"""
    try:
        r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                            '-of', 'default=noprint_wrappers=1:nokey=1', filepath],
                           capture_output=True, text=True, timeout=10)
        return float(r.stdout.strip())
    except Exception:
        return 0

def has_instrumental_tag(filepath):
    """检查文件是否已有 INSTRUMENTAL=1 metadata。"""
    try:
        r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries',
                            'format_tags=INSTRUMENTAL', '-of', 'default=noprint_wrappers=1:nokey=1',
                            filepath], capture_output=True, text=True, timeout=10)
        return r.stdout.strip() == '1'
    except Exception:
        return False

def write_instrumental_tag(filepath):
    """给文件写入 INSTRUMENTAL=1 metadata（复制流，不重编码）。"""
    tmp = filepath + '.tmp.flac'
    try:
        r = subprocess.run(['ffmpeg', '-y', '-i', filepath, '-c:a', 'copy',
                            '-metadata', 'INSTRUMENTAL=1', tmp],
                           capture_output=True, text=True, timeout=60)
        if r.returncode == 0 and os.path.exists(tmp) and os.path.getsize(tmp) > 0:
            os.replace(tmp, filepath)
            return True
    except Exception:
        pass
    if os.path.exists(tmp):
        try: os.remove(tmp)
        except Exception: pass
    return False

def scan_files(root, only_uncertain=False):
    """扫描目录下所有音频文件。only_uncertain=True 时只返回没有 INSTRUMENTAL 标记的。"""
    files = []
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d.lower() not in ('_flac_sample', '@eaDir')]
        for f in fns:
            if f.lower().endswith(AUDIO_EXTS):
                fp = os.path.join(dp, f)
                if only_uncertain and has_instrumental_tag(fp):
                    continue
                files.append(fp)
    return sorted(files)

def detect_file(model, filepath, duration=30, threshold=-0.8):
    """用 faster-whisper 检测单个文件是否为纯音乐。
    返回 (is_instrumental: bool, info: dict)。
    """
    info = {'file': filepath, 'instrumental': False, 'reason': '',
            'text': '', 'avg_logprob': 0.0, 'duration': duration, 'segments': 0}
    try:
        # 只转写前 duration 秒（faster-whisper 的 transcription 支持 duration 参数）
        segments, info_obj = model.transcribe(
            filepath,
            language=None,        # 自动检测语言
            beam_size=1,          # 快速模式，不需要高精度
            vad_filter=True,      # 启用 VAD，跳过纯静音段
            duration=duration,    # 只处理前 N 秒
        )
        texts = []
        total_logprob = 0.0
        seg_count = 0
        for seg in segments:
            txt = (seg.text or '').strip()
            if txt:
                texts.append(txt)
                total_logprob += seg.avg_logprob
                seg_count += 1
        full_text = ' '.join(texts).strip()
        info['text'] = full_text[:200]
        info['segments'] = seg_count
        info['avg_logprob'] = total_logprob / seg_count if seg_count > 0 else 0.0

        # 判定逻辑：
        # 1. 没有任何转写片段 → 纯音乐
        if seg_count == 0 or not full_text:
            info['instrumental'] = True
            info['reason'] = '转写结果为空（无人声）'
            return True, info
        # 2. 转写结果只有无意义语气词/乐器名 → 纯音乐
        if MEANINGLESS_RE.search(full_text) and len(full_text) < 30:
            info['instrumental'] = True
            info['reason'] = '转写结果为无意义语气词/乐器名'
            return True, info
        # 3. 平均对数概率极低（模型对转写结果不自信，可能是音乐声被误识别）→ 纯音乐
        if info['avg_logprob'] < threshold and seg_count <= 2:
            info['instrumental'] = True
            info['reason'] = f'平均对数概率极低({info["avg_logprob"]:.2f}<{threshold})，疑似音乐声误识别'
            return True, info
        # 4. 有人声
        info['instrumental'] = False
        info['reason'] = f'检测到人声（{seg_count}段，平均置信度{info["avg_logprob"]:.2f}）'
        return False, info
    except Exception as e:
        info['reason'] = f'检测失败: {str(e)[:100]}'
        return False, info

def main():
    ap = argparse.ArgumentParser(description='纯音乐/无人声 音频检测（Whisper 人声复核）')
    ap.add_argument('--root', default='', help='扫描根目录')
    ap.add_argument('--file', default='', help='只检测单个文件')
    ap.add_argument('--model', default='small', choices=['tiny', 'base', 'small', 'medium'],
                    help='Whisper 模型（tiny/base 最快，small 平衡，medium 最准）')
    ap.add_argument('--duration', type=int, default=30, help='每首歌只检测前 N 秒（默认30）')
    ap.add_argument('--threshold', type=float, default=-0.8,
                    help='平均对数概率阈值，低于此值且片段少则视为纯音乐（默认-0.8）')
    ap.add_argument('--report', default='detect_instrumental_report.jsonl', help='检测报告输出路径')
    ap.add_argument('--write-tag', action='store_true', help='检测为纯音乐后直接写入 INSTRUMENTAL=1 metadata')
    ap.add_argument('--only-uncertain', action='store_true', help='只检测没有 INSTRUMENTAL 标记的文件')
    ap.add_argument('--limit', type=int, default=0, help='最多检测 N 个文件（0=不限）')
    ap.add_argument('--device', default='auto', choices=['auto', 'cuda', 'cpu'], help='推理设备')
    args = ap.parse_args()

    if not args.root and not args.file:
        print('请指定 --root 或 --file')
        sys.exit(1)

    # 收集文件
    if args.file:
        files = [args.file] if os.path.exists(args.file) else []
    else:
        log(f'扫描目录: {args.root}')
        files = scan_files(args.root, only_uncertain=args.only_uncertain)
    if args.limit > 0:
        files = files[:args.limit]
    log(f'待检测文件数: {len(files)}')
    if not files:
        log('没有可检测的文件')
        return

    # 加载 faster-whisper 模型
    log(f'加载 Whisper 模型: {args.model} (device={args.device})...')
    try:
        from faster_whisper import WhisperModel
        device = args.device
        if device == 'auto':
            try:
                import torch
                device = 'cuda' if torch.cuda.is_available() else 'cpu'
            except Exception:
                device = 'cpu'
        compute = 'float16' if device == 'cuda' else 'int8'
        model = WhisperModel(args.model, device=device, compute_type=compute)
        log(f'模型加载完成，设备={device}, 精度={compute}')
    except ImportError:
        log('错误: 未安装 faster-whisper。请运行: pip install faster-whisper')
        sys.exit(1)
    except Exception as e:
        log(f'模型加载失败: {e}')
        sys.exit(1)

    # 检测
    t0 = time.time()
    n_instr = n_vocal = n_fail = 0
    with open(args.report, 'w', encoding='utf-8') as rf:
        for i, fp in enumerate(files):
            log(f'[{i+1}/{len(files)}] 检测: {os.path.basename(fp)}')
            is_instr, info = detect_file(model, fp, duration=args.duration, threshold=args.threshold)
            info['time'] = time.strftime('%Y-%m-%d %H:%M:%S')
            rf.write(json.dumps(info, ensure_ascii=False) + '\n')
            rf.flush()

            if info['reason'].startswith('检测失败'):
                n_fail += 1
                log(f'  ✗ 失败: {info["reason"]}')
            elif is_instr:
                n_instr += 1
                log(f'  ♪ 纯音乐: {info["reason"]} | {info["text"][:60]}')
                if args.write_tag:
                    ok = write_instrumental_tag(fp)
                    log(f'    {"已写入" if ok else "写入失败"} INSTRUMENTAL=1 tag')
            else:
                n_vocal += 1
                log(f'  ♫ 有人声: {info["reason"]} | {info["text"][:60]}')

    elapsed = time.time() - t0
    log('=' * 60)
    log(f'检测完成: 总{len(files)}首, 纯音乐{n_instr}首, 有人声{n_vocal}首, 失败{n_fail}首')
    log(f'总用时: {elapsed/60:.1f}分钟, 平均每首: {elapsed/max(1,len(files)):.1f}秒')
    log(f'报告已保存: {args.report}')
    if args.write_tag:
        log(f'已为 {n_instr} 首纯音乐写入 INSTRUMENTAL=1 metadata')
    log('=' * 60)

if __name__ == '__main__':
    main()
