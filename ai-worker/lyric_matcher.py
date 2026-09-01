# -*- coding: utf-8 -*-
"""
lyric_matcher.py —— 中文歌词「官方正确文本 × WhisperX 逐字时间戳」对齐校正
==============================================================================
解决的问题：
  WhisperX 靠"听"识别歌词，时间戳很准（毫秒级），但会【认错字】（邓紫棋《龙卷风》
  被识别成同音字/乱码）、漏字、把和声也识别出来。而本地同名 .lrc / 网易云·QQ·酷我
  刮削到的官方歌词【文字是对的】，却只有逐行时间、没有逐字时间。

做法（借鉴 tuidra-musicvideo-maker 的 3 阶段匹配思想，改成中文适配 + 全局最优）：
  把"识别字序列"和"官方字序列"做一次带【顺序约束】的全局序列对齐（编辑距离 DP）：
    阶段1 精确匹配：识别字 == 官方字，代价 0
    阶段2 语音匹配：转拼音后相同（同音字/多音字），代价很小   ← 中文纠错关键
    阶段3 模糊匹配：拼音首字母相同等，代价中等；识别多出来的字(和声)允许跳过，
                    官方有但没识别到的字允许"留空后插值"，顺序永远不乱
  对齐后：官方每个字【继承】它所匹配识别字的精确时间戳；没匹配上的官方字在相邻
  已匹配字之间线性插值。最终输出"文字 100% 是官方正确歌词、时间来自 WhisperX"的逐字结果。

只依赖 Python 标准库；pypinyin 为可选增强（没有它就退化为纯字形匹配，仍可运行）。
"""
import re

# ---------- 可选拼音（阶段2 语音匹配用）。没装 pypinyin 也能跑，只是同音字纠错变弱 ----------
_PINYIN = None
def _pinyin_table(ch):
    """返回 (不带声调拼音, 带声调拼音)；非汉字返回 (None,None)。惰性加载 pypinyin。"""
    global _PINYIN
    try:
        if _PINYIN is None:
            from pypinyin import pinyin, Style
            _PINYIN = pinyin
            _STYLE_N, _STYLE_T = Style.NORMAL, Style.TONE
        if not ('一' <= ch <= '鿿'):
            return (None, None)
        n = _PINYIN(ch, style=_STYLE_N, errors='ignore')
        t = _PINYIN(ch, style=_STYLE_T, errors='ignore')
        pn = n[0][0] if n and n[0] else ''
        pt = t[0][0] if t and t[0] else ''
        return (pn or None, pt or None)
    except Exception:
        return (None, None)

# 唱出来的"有效字符"：汉字、英文字母、数字。标点/空格/换行不唱，对齐时忽略。
_SUNG = re.compile(r'[0-9A-Za-z\u4e00-\u9fff]')
def is_sung(ch):
    return bool(_SUNG.match(ch))

_LRC_T = re.compile(r'\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]')
_WORD_T = re.compile(r'<[^>]*>')

# 官方 LRC 开头常见的"制作信息行"（不是唱词，WhisperX 不会识别到，保留只会产生无意义插值）
_META_LINE = re.compile(
    r'^\s*(词|曲|作词|作曲|词曲|编曲|制作人|制片人|监制|和声|和音|混音|母带|录音|录音师|录音棚|'
    r'吉他|贝斯|鼓|键盘|弦乐|钢琴|编曲人|原唱|封面|设计|发行|出品|出品人|OP|SP|ISRC|'
    r'专辑|歌手|歌名|标题|制作|编写|歌词|program|Program|PROGRAM)\s*[:：]')
# 0 秒处的"歌名 - 歌手"标题行（不是唱词）
_TITLE_LINE = re.compile(r'\s*[-–—~]\s*\S')  # 含分隔符，结合 t<0.5s 判断

def parse_ref_lrc(text):
    """官方 LRC -> [(line_time_sec 或 None, 纯歌词文本)]。兼容增强LRC的<t>标签；过滤制作信息/标题行。"""
    lines = []
    for raw in str(text or '').splitlines():
        ts = []
        for m in _LRC_T.finditer(raw):
            mm = int(m.group(1)); rest = m.group(2).replace(':', '.')
            parts = rest.split('.')
            ss = int(parts[0]); frac = 0.0
            if len(parts) > 1:
                frac = int((parts[1] + '00')[:2]) / 100.0
            ts.append(mm * 60 + ss + frac)
        body = _WORD_T.sub('', _LRC_T.sub('', raw)).strip()
        if not body:
            continue
        if _META_LINE.match(body):
            continue  # 词：/曲：/编曲：/OP：等制作信息，不是唱词
        t0 = min(ts) if ts else None
        if t0 is not None and t0 < 0.5 and _TITLE_LINE.search(body):
            continue  # 0 秒处的"歌名 - 歌手"标题行
        lines.append((t0, body))
    lines.sort(key=lambda x: (x[0] is None, x[0] if x[0] is not None else 0))
    return lines

def flatten_ref(ref_lines):
    """官方逐行 -> 展平的字序列，并记录每个字属于哪一行。
    返回 chars:[{ch,line}]，line_spans:[(start,end)]（在 chars 里的半开区间）。"""
    chars = []
    spans = []
    for li, (_, text) in enumerate(ref_lines):
        a = len(chars)
        for ch in text:
            if is_sung(ch):
                chars.append({'ch': ch, 'line': li})
        spans.append((a, len(chars)))
    return chars, spans

def flatten_asr_words(words):
    """WhisperX 的 words:[{word,start,end}] -> 逐字 [(ch,t0,t1)]。
    WhisperX 中文一个 word 常含多个字（词/短句），在其 [start,end] 内按字数均摊。"""
    out = []
    for w in words or []:
        txt = (w.get('word') or '').strip()
        sung = [c for c in txt if is_sung(c)]
        if not sung:
            continue
        t0 = w.get('start'); t1 = w.get('end')
        if t0 is None:
            if out: t0 = out[-1][2]
            else: t0 = 0.0
        if t1 is None or t1 <= t0: t1 = t0 + 0.02 * len(sung)
        step = (t1 - t0) / len(sung)
        for k, c in enumerate(sung):
            out.append((c, t0 + step * k, t0 + step * (k + 1)))
    return out

def _sub_cost(ac, rc):
    """单个识别字 ac 与单个官方字 rc 的对齐代价（越小越像）。"""
    if ac == rc:
        return 0.0
    if ac.lower() == rc.lower():
        return 0.05
    an, at = _pinyin_table(ac)
    rn, rt = _pinyin_table(rc)
    if an and rn:
        if an == rn:                      # 拼音完全相同（同音/多音字）——纠错主力
            return 0.08 if at != rt else 0.05
        if an[0] == rn[0]:                # 声母/首字母相同，弱相似
            return 0.42
    return 1.0

# 跳过代价：识别多字(和声/误识别)删一个 ASR；官方字没识别到留空(后插值)
GAP_A = 0.35   # 删 ASR 字
GAP_R = 0.55   # 删 参考字

def align_sequences(asr, ref_chars):
    """带顺序约束的全局序列对齐（Needleman-Wunsch）。
    返回 matches:[(asr_idx, ref_idx)]；其余 ref 字即为未匹配(待插值)。"""
    n, m = len(asr), len(ref_chars)
    # dp：(n+1)*(m+1) 最小累计代价；back：1=删ASR(上) 2=删REF(左) 0=匹配(左上)
    dp = [[0.0] * (m + 1) for _ in range(n + 1)]
    back = bytearray((n + 1) * (m + 1))
    for i in range(1, n + 1):
        dp[i][0] = i * GAP_A; back[i * (m + 1)] = 1
    for j in range(1, m + 1):
        dp[0][j] = j * GAP_R; back[j] = 2
    width = m + 1
    for i in range(1, n + 1):
        ac = asr[i - 1][0]
        row = dp[i]; prev = dp[i - 1]
        base = i * width
        for j in range(1, m + 1):
            rc = ref_chars[j - 1]['ch']
            c_match = prev[j - 1] + _sub_cost(ac, rc)
            c_a = prev[j] + GAP_A          # 跳过识别字
            c_r = row[j - 1] + GAP_R       # 官方字留空
            if c_match <= c_a and c_match <= c_r:
                row[j] = c_match; back[base + j] = 0
            elif c_a <= c_r:
                row[j] = c_a; back[base + j] = 1
            else:
                row[j] = c_r; back[base + j] = 2
    # 回溯
    matches = []
    i, j = n, m
    while i > 0 or j > 0:
        b = back[i * width + j]
        if i > 0 and j > 0 and b == 0:
            matches.append((i - 1, j - 1)); i -= 1; j -= 1
        elif i > 0 and (j == 0 or b == 1):
            i -= 1
        else:
            j -= 1
    matches.reverse()
    return matches

def _interpolate(times, per_char=0.22, max_gap=1.5):
    """对 None（未匹配字）用相邻已匹配时间线性插值；首尾用每字估计时长外推。保证单调不减。
    
    修复：当两个已匹配锚点之间间隔 > max_gap 秒时（WhisperX漏字+间奏），
    未匹配字紧凑排列在后一个锚点之前，而不是把长间隔均摊给每个字（会导致逐字扫色被拉长）。
    """
    m = len(times)
    known = [k for k, t in enumerate(times) if t is not None]
    if not known:
        return False
    f0 = known[0]
    for k in range(f0 - 1, -1, -1):
        times[k] = max(0.0, times[f0] - (f0 - k) * per_char)
    for a, b in zip(known, known[1:]):
        gap = times[b] - times[a]
        n_missing = b - a - 1
        if n_missing <= 0:
            continue
        if gap > max_gap:
            # 长间隔（WhisperX漏字+间奏）：未匹配字紧凑排列在前锚点之后
            # 漏的字应该紧跟前一个唱完的字，剩余时间留给间奏
            for k in range(a + 1, b):
                offset_from_a = k - a  # 距离前锚点几个字
                times[k] = times[a] + offset_from_a * per_char
        else:
            # 正常间隔：线性插值
            for k in range(a + 1, b):
                times[k] = times[a] + gap * (k - a) / (b - a)
    fl = known[-1]
    for k in range(fl + 1, m):
        times[k] = times[fl] + (k - fl) * per_char
    for k in range(1, m):
        if times[k] < times[k - 1]:
            times[k] = times[k - 1] + 0.01
    return True

def correct_with_reference(asr_words, ref_lrc_text):
    """主入口：用官方 LRC 文本校正 WhisperX 逐字识别。
    返回 (out_lines, info)。
      out_lines: [{'start':float,'tokens':[{'t':float,'ch':str}]}]（文字=官方，时间=对齐）
      info: {'score':匹配率, 'matched':x, 'total':y, 'lines':行数}
    官方歌词为空/完全对不上时返回 (None, info)，调用方应回退纯 WhisperX 结果。"""
    ref_lines = parse_ref_lrc(ref_lrc_text)
    ref_chars, spans = flatten_ref(ref_lines)
    asr = flatten_asr_words(asr_words)
    if not ref_chars or not asr:
        return None, {'score': 0.0, 'matched': 0, 'total': len(ref_chars), 'reason': 'empty'}
    matches = align_sequences(asr, ref_chars)
    times = [None] * len(ref_chars)
    matched = 0
    for ai, ri in matches:
        # 只把"足够像"的配对当锚点（同字/拼音/弱相似），完全不像的不赋时间，交给插值
        if _sub_cost(asr[ai][0], ref_chars[ri]['ch']) <= 0.45:
            times[ri] = asr[ai][1]
            matched += 1
    score = matched / len(ref_chars)
    if not _interpolate(times):
        return None, {'score': 0.0, 'matched': matched, 'total': len(ref_chars), 'reason': 'no-anchor'}
    # 同一行内相邻已匹配锚点间隔过长（>3秒）时，前一个锚点很可能是WhisperX误识别
    # （如歌曲开头噪声被识别成"2002"），把该行所有锚点时间统一到最后一个合理锚点附近
    INLINE_LONG_GAP = 3.0
    for li, (line_t, body) in enumerate(ref_lines):
        a, b = spans[li]
        if b - a < 2:
            continue
        # 找该行内所有已匹配锚点
        anchors = [(k, times[k]) for k in range(a, b) if times[k] is not None]
        if len(anchors) < 2:
            continue
        # 检查相邻锚点间隔
        for idx in range(len(anchors) - 1):
            k1, t1 = anchors[idx]
            k2, t2 = anchors[idx + 1]
            if t2 - t1 > INLINE_LONG_GAP:
                # 前锚点是误识别，把前锚点及其之前的字都移到后锚点附近
                per = 0.22
                for k in range(a, k2):
                    times[k] = max(0.0, times[k2] - (k2 - k) * per)

    out_lines = []
    for li, (line_t, body) in enumerate(ref_lines):
        a, b = spans[li]
        if b <= a:
            continue
        toks = [{'t': round(times[k], 3), 'ch': ref_chars[k]['ch']} for k in range(a, b)]
        start = toks[0]['t']
        # 整行一个锚点都没匹配上、且官方给了行时间，则用官方行时间兜底平移本行
        anchored = any(times[k] is not None for k in range(a, b))
        if not anchored and line_t is not None:
            shift = line_t - start
            toks = [{'t': round(max(0, t['t'] + shift), 3), 'ch': t['ch']} for t in toks]
            start = toks[0]['t']
        out_lines.append({'start': round(start, 3), 'tokens': toks})
    return out_lines, {'score': round(score, 3), 'matched': matched,
                       'total': len(ref_chars), 'lines': len(out_lines)}
