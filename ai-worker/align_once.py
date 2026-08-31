# -*- coding: utf-8 -*-
"""
align_once.py —— 单首歌的逐字歌词对齐（被 worker.py 以子进程调用）
用法: python align_once.py <人声或源音频> <输出逐字增强LRC> [模型] [官方参考歌词.lrc]
流程: Whisper 转写(中文) -> WhisperX 强制对齐 -> 每个字精确时间戳
      若提供了【官方参考歌词】(本地同名lrc/三源刮削)，再用 lyric_matcher 以官方正确
      文本校正识别错字/同音字/乱码，并剔除和声，时间戳仍用 WhisperX 的（文字对+时间准）。

增强 LRC 格式（供 tvOS/网页做逐字填色，同时向下兼容逐行）：
  [整句起始] <第1字起始>第1字<第2字起始>第2字...
  例: [00:13.72]<00:13.72>海<00:14.10>平<00:14.50>面
"""
import sys, os, traceback

# Windows GBK控制台强制UTF-8输出，避免打印含特殊字符的信息时崩溃
if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

# 国内直连 HuggingFace 常超时，会导致 Whisper转写模型 / 中文对齐模型下载失败（历史60个对齐任务全因此失败）。
# 默认走 hf-mirror 镜像；若用户已显式设置 HF_ENDPOINT，则尊重用户设置。必须在 import torch/whisperx 之前执行。
os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')

def fmt(t):
    if t is None or t < 0: t = 0.0
    m = int(t // 60); s = t - m * 60
    return f'{m:02d}:{s:05.2f}'  # mm:ss.xx（LRC 百分秒）

def build_enhanced_lrc(aligned):
    out = []
    for seg in aligned.get('segments', []):
        words = seg.get('words') or []
        words = [w for w in words if w.get('word')]
        if not words:
            continue
        t0 = words[0].get('start')
        if t0 is None: t0 = seg.get('start', 0.0) or 0.0
        parts = [f'[{fmt(t0)}]']
        cur = t0
        for w in words:
            st = w.get('start')
            if st is None: st = cur          # 个别字没对齐到时间就沿用上一字结尾
            txt = (w.get('word') or '').strip()
            if not txt: continue
            parts.append(f'<{fmt(st)}>{txt}')
            if w.get('end') is not None: cur = w['end']
        line = ''.join(parts)
        if len(line) > len('[00:00.00]'):
            out.append(line)
    return '\n'.join(out) + '\n'

# 用官方歌词校正后的逐字结果 -> 增强 LRC（文字=官方正确字，时间=WhisperX对齐）
def build_corrected_lrc(out_lines):
    rows = []
    for ln in out_lines:
        parts = [f'[{fmt(ln["start"])}]']
        for tok in ln['tokens']:
            parts.append(f'<{fmt(tok["t"])}>{tok["ch"]}')
        if len(parts) > 1:
            rows.append(''.join(parts))
    return '\n'.join(rows) + '\n'

def main():
    if len(sys.argv) < 3:
        print('用法: python align_once.py <音频> <输出.lrc> [模型] [官方参考歌词.lrc]'); sys.exit(2)
    src, out_lrc = sys.argv[1], sys.argv[2]
    model_name = sys.argv[3] if len(sys.argv) > 3 else 'large-v3'
    ref_path = sys.argv[4] if len(sys.argv) > 4 else ''
    if not os.path.exists(src):
        print('输入不存在:', src); sys.exit(2)
    ref_text = ''
    if ref_path and os.path.exists(ref_path):
        with open(ref_path, 'r', encoding='utf-8', errors='replace') as f:
            ref_text = f.read()
        print(f'收到官方参考歌词 {len(ref_text)} 字符，将用于纠错', flush=True)

    print('PROGRESS 5', flush=True)
    import torch
    # PyTorch 2.6 默认 torch.load(weights_only=True)，会拒绝 WhisperX/pyannote/Demucs 模型里的
    # 自定义类（omegaconf.ListConfig 等），导致加载崩溃。统一 monkey-patch 回 weights_only=False。
    _orig_load = torch.load
    def _safe_load(*a, **kw):
        kw['weights_only'] = False  # 强制覆盖：lightning_fabric/pyannote 显式传 weights_only=True 也改回 False
        return _orig_load(*a, **kw)
    torch.load = _safe_load
    import whisperx
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    compute = 'float16' if device == 'cuda' else 'int8'
    print(f'设备 {device}, 转写模型 {model_name}', flush=True)

    audio = whisperx.load_audio(src)
    print('PROGRESS 20', flush=True)
    model = whisperx.load_model(model_name, device, compute_type=compute, language='zh')
    result = model.transcribe(audio, batch_size=16, language='zh')
    print(f'转写得到 {len(result["segments"])} 句', flush=True)
    print('PROGRESS 55', flush=True)

    # 中文强制对齐模型（首次自动从 HuggingFace 下载）
    model_a, meta = whisperx.load_align_model(language_code='zh', device=device)
    aligned = whisperx.align(result['segments'], model_a, meta, audio, device,
                            return_char_alignments=False)
    print('PROGRESS 85', flush=True)

    # 优先用官方歌词文本校正（解决识别错字/同音乱码/和声）；失败则回退纯识别结果
    lrc = ''
    if ref_text.strip():
        try:
            from lyric_matcher import correct_with_reference
            all_words = [w for seg in aligned.get('segments', []) for w in (seg.get('words') or [])]
            corr, info = correct_with_reference(all_words, ref_text)
            print(f'官方歌词校正: 匹配率={info.get("score")} '
                  f'({info.get("matched")}/{info.get("total")}) 行={info.get("lines")}', flush=True)
            # 匹配率达到 40% 才采信校正结果（否则说明参考歌词可能不是这首歌，回退更安全）
            if corr and info.get('score', 0) >= 0.40:
                lrc = build_corrected_lrc(corr)
                print('已用官方歌词文本校正逐字结果', flush=True)
            else:
                print('匹配率过低，参考歌词疑似不匹配本音频，回退纯WhisperX结果', flush=True)
        except Exception as e:
            print('官方歌词校正异常(回退):', repr(e), flush=True)

    if not lrc.strip():
        lrc = build_enhanced_lrc(aligned)
    if not lrc.strip():
        raise RuntimeError('对齐后没有得到任何歌词行')
    os.makedirs(os.path.dirname(out_lrc) or '.', exist_ok=True)
    with open(out_lrc, 'w', encoding='utf-8') as f:
        f.write(lrc)
    print('逐字歌词 ->', out_lrc, f'({lrc.count(chr(10))} 行)', flush=True)
    print('PROGRESS 100', flush=True)
    print('ALIGN_DONE', flush=True)

if __name__ == '__main__':
    try:
        main()
    except Exception:
        traceback.print_exc(); sys.exit(1)
