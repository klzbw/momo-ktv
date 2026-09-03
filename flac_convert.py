# -*- coding: utf-8 -*-
"""
flac_convert.py —— 墨墨爱K歌 曲库统一 FLAC 转换（跑在 PC51 工作站，直连挂载盘 M:）
================================================================================
功能：
  mode=cue    : 整轨 CDImage.ape/wav/flac + .cue -> 按轨切分 -> 逐首 FLAC
  mode=single : 普通单曲 wav/ape/... -> FLAC（后续启用）
命名（六段）：序号-人名-歌名-语言-风格-专辑.flac
输出：镜像源目录结构到 --out-root（默认 M:\\all-flacs）
特性：多进程高并发、断点续跑（已存在且非空跳过）、坏帧质检、日志+失败清单。

用法（在 ai-worker 目录、用 .venv 的 python）：
  python flac_convert.py --mode cue --workers 8 --dry                 # 只规划不转
  python flac_convert.py --mode cue --workers 8 --only 浏阳河          # 只转匹配的一张(验证)
  python flac_convert.py --mode cue --workers 8                       # 全量
  python flac_convert.py --mode cue --workers 8 --rescan-verify       # 对已生成做解码质检
"""
import argparse, os, sys, re, json, time, subprocess, shutil
from concurrent.futures import ProcessPoolExecutor, as_completed

if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

DEFAULT_ROOT = r'\\192.168.3.80\music'
def _pick(exe, fallback):
    p = shutil.which(exe)
    if p and os.path.exists(p):
        return p
    return fallback if os.path.exists(fallback) else None

FFMPEG = _pick('ffmpeg', r'C:\ffmpeg\bin\ffmpeg.exe')
FFPROBE = _pick('ffprobe', r'C:\ffmpeg\bin\ffprobe.exe')

def verify_ok(out):
    """返回(是否通过, 信息)。优先 ffprobe；无 ffprobe 则用 ffmpeg 全解码到 null 查坏帧。"""
    try:
        if FFPROBE:
            q = subprocess.run([FFPROBE, '-v', 'error', out],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            return q.stderr.strip() == b'', q.stderr.decode('utf-8', 'replace')[:200]
        q = subprocess.run([FFMPEG, '-v', 'error', '-i', out, '-f', 'null', '-'],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return q.stderr.strip() == b'', q.stderr.decode('utf-8', 'replace')[:200]
    except Exception as e:
        return False, str(e)[:200]

def ensure_share(share, user, pw):
    """脚本自包含建立带凭据的 SMB 连接（不依赖交互登录盘符，后台/计划任务也能用）。"""
    if not (share or '').startswith(r'\\'):
        return
    def _run(args):
        return subprocess.run(['net', 'use'] + args, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, text=True, errors='replace')
    _run([share, '/delete', '/y'])  # 清掉可能的 Unavailable 旧连接，忽略错误
    if user and pw:
        r = _run([share, '/user:' + user, pw])
    else:
        r = _run([share])  # 依赖当前已缓存凭据
    ok = os.path.exists(share)
    log('SMB 连接', share, '可达=', ok, ('' if ok else (r.stdout or '')[:200]))

INSTR_RE = re.compile(r'古筝|二胡|钢琴|吉他|琵琶|笛子?|箫|笙|唢呐|马头琴|纯音乐|演奏|民乐|交响|协奏曲|提琴|葫芦丝|巴乌|轻音乐|器乐|试音|HIFI|古琴|扬琴|京胡|三弦|江南丝竹|吹打', re.I)
STYLE_MAP = [
    # 制作方式/非风格（排在前面，用于过滤而非返回）
    ('发烧', None), ('HIFI', None), ('HQCD', None), ('DSD', None), ('K2HD', None),
    ('XRCD', None), ('LP', None), ('黑胶', None), ('正版', None), ('原抓', None),
    ('UPM', None), ('AQCD', None), ('BSCD', None), ('LPCD', None), ('SHMCD', None),
    ('SACD', None), ('HDCD', None), ('金碟', None), ('银碟', None), ('母带', None),
    ('论坛', None), ('炫音', None), ('倦鸟', None), ('收藏', None), ('残阳', None),
    ('小雨', None), ('Other', None), ('Unknown', None), ('未知', None),
    # 真正的音乐风格
    ('古典', '古典'), ('交响曲', '古典'), ('协奏曲', '古典'), ('奏鸣曲', '古典'),
    ('贝多芬', '古典'), ('莫扎特', '古典'), ('巴赫', '古典'), ('肖邦', '古典'),
    ('舒伯特', '古典'), ('柴可夫斯基', '古典'), ('德沃夏克', '古典'), ('门德尔松', '古典'),
    ('钢琴', '纯音乐'), ('小提琴', '纯音乐'), ('大提琴', '纯音乐'), ('萨克斯', '纯音乐'),
    ('纯音乐', '纯音乐'), ('轻音乐', '纯音乐'), ('New Age', '纯音乐'), ('新世纪', '纯音乐'),
    ('民乐', '民族'), ('民族', '民族'), ('古筝', '民族'), ('二胡', '民族'), ('古琴', '民族'),
    ('琵琶', '民族'), ('笛子', '民族'), ('箫', '民族'), ('唢呐', '民族'), ('扬琴', '民族'),
    ('草原', '民族'), ('高原', '民族'), ('蒙古', '民族'), ('西藏', '民族'), ('新疆', '民族'),
    ('傣族', '民族'), ('苗族', '民族'), ('藏族', '民族'), ('维吾尔', '民族'),
    ('流行', '流行'), ('Pop', '流行'), ('情歌', '流行'), ('爱情', '流行'),
    ('摇滚', '摇滚'), ('Rock', '摇滚'), ('金属', '摇滚'), ('Metal', '摇滚'),
    ('爵士', '爵士'), ('Jazz', '爵士'), ('蓝调', '爵士'), ('Blues', '爵士'),
    ('电子', '电子'), ('Electronic', '电子'), ('DJ', '电子'), ('舞曲', '电子'),
    ('Dance', '电子'), ('Remix', '电子'),
    ('民谣', '民谣'), ('Folk', '民谣'), ('校园', '民谣'),
    ('R&B', 'R&B'), ('节奏布鲁斯', 'R&B'), ('灵魂', 'R&B'), ('Soul', 'R&B'),
    ('嘻哈', '嘻哈'), ('Hip-Hop', '嘻哈'), ('说唱', '嘻哈'), ('Rap', '嘻哈'),
    ('乡村', '乡村'), ('Country', '乡村'),
    ('原声', '原声'), ('OST', '原声'), ('Soundtrack', '原声'), ('影视', '原声'),
    ('儿歌', '儿童'), ('儿童', '儿童'), ('童谣', '儿童'),
    ('佛歌', '宗教'), ('佛乐', '宗教'), ('禅乐', '宗教'), ('宗教', '宗教'), ('基督', '宗教'),
    ('老歌', '经典'), ('经典', '经典'), ('怀旧', '经典'),
    ('试音', '试音'), ('试机', '试音'),
    ('群星', '合辑'), ('合辑', '合辑'), ('合集', '合辑'), ('精选', '合辑'),
    ('环绕', '环绕'), ('DTS', '环绕'), ('5.1', '环绕'),
    ('粤语', '流行'), ('台语', '流行'), ('闽南语', '流行'),
]

def guess_style(genre, near_text):
    """推断音乐风格。先过滤无效genre，再从near_text关键词匹配，最后按语种默认。"""
    # 1. 处理cue里的genre
    if genre and genre.strip():
        g = genre.strip()
        # 检查是否是无效值（制作方式/论坛名等）
        u = g.upper()
        for k, v in STYLE_MAP:
            if k.upper() == u and v is None:
                g = ''
                break
        if g:
            # 检查是否是有效风格
            for k, v in STYLE_MAP:
                if k.upper() == u and v is not None:
                    return v
            # 不在映射里但非空，可能是有效风格，清理后返回
            g = re.sub(r'\s+', ' ', g).strip(' -_·')
            if g and g.lower() not in ('other', 'unknown', '未知'):
                return g
    # 2. 从目录/专辑名关键词推断
    u = near_text.upper()
    for k, v in STYLE_MAP:
        if v is not None and k.upper() in u:
            return v
    # 3. 按语种默认
    if '纯音乐' in near_text or 'instrumental' in near_text.lower():
        return '纯音乐'
    return '流行'
BAD_FN = re.compile(r'[\\/:*?"<>|\r\n\t]')

def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)

# ---------- cue 解析 ----------
def read_text_auto(p):
    b = open(p, 'rb').read()
    for enc in ('utf-8-sig', 'utf-8', 'gbk', 'gb18030', 'latin1'):
        try:
            return b.decode(enc)
        except Exception:
            continue
    return b.decode('gbk', errors='replace')

def cue_time(mm, ss, ff):
    ff = min(int(ff), 74)
    return int(mm) * 60 + int(ss) + ff / 75.0

def strip_q(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == '"' and v[-1] == '"':
        v = v[1:-1]
    return v.strip()

def parse_cue(text):
    album = {'title': '', 'performer': '', 'date': '', 'genre': '', 'file': ''}
    tracks = []
    cur = None
    in_track = False
    for raw in text.splitlines():
        line = raw.strip()
        m = re.match(r'^(\S+)\s+(.*)$', line)
        if not m:
            continue
        key = m.group(1).upper()
        rest = m.group(2)
        if key == 'FILE':
            v = re.sub(r'\s+(WAVE|MP3|AIFF|BINARY)$', '', rest, flags=re.I)
            album['file'] = strip_q(v)
            continue
        if key == 'TRACK':
            if cur:
                tracks.append(cur)
            no = re.split(r'\s+', rest)[0]
            cur = {'no': no.zfill(2), 'title': '', 'performer': '', 'genre': '', 'index': None}
            in_track = True
            continue
        # REM xxx
        rem = re.match(r'^(\S+)\s+(.*)$', rest) if key == 'REM' else None
        if not in_track:
            if key == 'TITLE': album['title'] = strip_q(rest)
            elif key == 'PERFORMER': album['performer'] = strip_q(rest)
            elif key == 'DATE': album['date'] = strip_q(rest)
            elif key == 'GENRE': album['genre'] = strip_q(rest)
            if rem:
                rk, rv = rem.group(1).upper(), strip_q(rem.group(2))
                if rk == 'DATE': album['date'] = rv
                elif rk == 'GENRE': album['genre'] = rv
        else:
            if key == 'TITLE': cur['title'] = strip_q(rest)
            elif key == 'PERFORMER': cur['performer'] = strip_q(rest)
            elif key == 'INDEX':
                mm = re.match(r'^01\s+(\d+):(\d+):(\d+)$', rest)
                if mm:
                    cur['index'] = cue_time(mm.group(1), mm.group(2), mm.group(3))
            if rem and rem.group(1).upper() == 'GENRE':
                cur['genre'] = strip_q(rem.group(2))
    if cur:
        tracks.append(cur)
    for i, t in enumerate(tracks):
        t['end'] = tracks[i + 1]['index'] if i + 1 < len(tracks) else None
    return album, tracks

# ---------- 命名/推断 ----------
SITE_RE = re.compile(
    r'[【\[\(][^】\]\)]*(?:www\.|https?://|[\w-]+\.(?:com|cn|net|org|cc|tv|io|me|co|info|biz|top|xyz|vip|club|site|online|store|tech|app|dev|cloud|zone|fm|radio))[^】\]\)]*[】\]\)]',
    re.I)
DOMAIN_RE = re.compile(
    r'(?:www\.)?[a-zA-Z0-9][a-zA-Z0-9-]*\.(?:com|cn|net|org|cc|tv|io|me|co|info|biz|top|xyz|vip|club|site|online|store|tech|app|dev|cloud|zone|fm|radio)(?:\.(?:com|cn|net|org))?',
    re.I)

def remove_site_info(s):
    """移除字符串中的网站域名和网站标记。"""
    if not s:
        return s
    x = SITE_RE.sub(' ', s)
    x = DOMAIN_RE.sub(' ', x)
    # 清理中文"点"格式域名，如 3W点gphifi点com、www点xxx点com
    x = re.sub(r'[a-zA-Z0-9][a-zA-Z0-9-]*点[a-zA-Z0-9][a-zA-Z0-9-]*点(?:com|cn|net|org|cc|tv|io|me|co|info|biz|top|xyz|vip|club|site|online|store|tech|app|dev|cloud|zone|fm|radio)', ' ', x, flags=re.I)
    x = re.sub(r'(?:3W|www|WWW)点[a-zA-Z0-9][a-zA-Z0-9-]*点(?:com|cn|net|org)', ' ', x, flags=re.I)
    # 清理gphifi等特定网站名
    x = re.sub(r'gphifi', ' ', x, flags=re.I)
    x = re.sub(r'\s+', ' ', x).strip(' -－_·')
    return x

def clean_seg(s):
    x = BAD_FN.sub(' ', s or '').replace('-', '－')
    x = remove_site_info(x)
    x = re.sub(r'\s+', ' ', x).strip()
    return x or '未知'

ARTIST_KEYS = (
    '专辑艺人', '艺术家', '演唱者?', '演奏者?', '艺人', '歌手', '表演者',
    '演出者?', '演奏', '作曲', '指挥', '主唱', '演唱', 'artist', 'performer',
    'ARTIST', 'PERFORMER', 'Artist', 'Performer'
)

def _extract_artist_from_text(t):
    """从文本中提取艺术家信息。"""
    for key in ARTIST_KEYS:
        m = re.search(r'(?:^|\n)\s*' + key + r'\s*[:：]\s*([^\r\n]+)', t)
        if m:
            v = m.group(1).strip()
            if v and v not in ('未知', 'Unknown', 'unknown', 'Various', 'various', 'VA', 'va'):
                return v
    return ''

def artist_from_dirname(d):
    """从目录名推断艺术家（格式：艺术家-专辑名 或 艺术家《专辑名》）。"""
    base = os.path.basename(d)
    # 去掉常见后缀标记
    base = re.sub(r'\[(WAV|APE|FLAC|DTS|DSD|HQCD|K2HD|XRCD|LP|黑胶)[^\]]*\]', '', base, flags=re.I)
    base = re.sub(r'[（(][^）)]*(WAV|APE|FLAC|DTS|DSD|整轨|分轨|无损)[^）)]*[）)]', '', base, flags=re.I)
    base = base.strip(' -_·')
    # 尝试 "艺术家-专辑名" 格式
    m = re.match(r'^([^－\-《【\[]+?)[－\-]\s*(.+)$', base)
    if m:
        artist = m.group(1).strip()
        if artist and len(artist) <= 30 and not re.search(r'(专辑|唱片|音乐|合集|精选|系列|CD|Disc|disk)', artist, re.I):
            return artist
    # 尝试 "艺术家《专辑名》" 格式
    m = re.match(r'^([^《【\[]+?)[《【]', base)
    if m:
        artist = m.group(1).strip(' -_·')
        if artist and len(artist) <= 30 and not re.search(r'(专辑|唱片|音乐|合集|精选|系列|CD|Disc)', artist, re.I):
            return artist
    return ''

def artist_from_txt(d, max_up=2):
    """从当前目录及上级目录的txt文件中提取艺术家信息，其次从目录名推断。"""
    # 1. 从当前目录及上级目录的txt提取
    cur = d
    for level in range(max_up + 1):
        try:
            for f in os.listdir(cur):
                if f.lower().endswith('.txt'):
                    t = read_text_auto(os.path.join(cur, f))
                    a = _extract_artist_from_text(t)
                    if a:
                        return a
        except Exception:
            pass
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    # 2. 从目录名推断
    return artist_from_dirname(d)

GENERIC_TITLE_RE = re.compile(r'^(Track|音轨|track|TRACK|Unknown Title|未知标题|Untitled|Audio Track)\d*$', re.I)

def parse_track_list_from_text(text):
    """从txt文本解析曲目列表，返回 {序号: 歌名}。"""
    tracks = {}
    for line in text.splitlines():
        line = line.strip()
        m = re.match(r'^(\d{1,3})[\s\.\、\．\-:：]+(.+)$', line)
        if m:
            no = int(m.group(1))
            title = m.group(2).strip()
            title = re.sub(r'\s*[\(（][^\)）]*[\)）]\s*$', '', title)
            title = re.sub(r'\s{2,}', ' ', title).strip(' -_·')
            if title and len(title) <= 150:
                tracks[no] = title
    return tracks

def infer_album_from_dir(d):
    """从目录名推断专辑名。"""
    base = os.path.basename(d)
    base = re.sub(r'\[(WAV|APE|FLAC|DTS|DSD|HQCD|K2HD|XRCD|LP|黑胶)[^\]]*\]', '', base, flags=re.I)
    base = re.sub(r'[（(][^）)]*(WAV|APE|FLAC|DTS|DSD|整轨|分轨|无损)[^）)]*[）)]', '', base, flags=re.I)
    base = base.strip(' -_·')
    if re.match(r'^(CD[A-Z]|CD\d|DISC\d|DISK\d)$', base, re.I):
        parent = os.path.basename(os.path.dirname(d))
        parent = re.sub(r'\[(WAV|APE|FLAC|DTS|DSD|HQCD)[^\]]*\]', '', parent, flags=re.I)
        return parent.strip(' -_·') + ' ' + base
    return base

def fix_tracks_from_txt(dp, album, tracks):
    """当cue歌名是Trackxx/音轨xx/未知标题时，从同级/上级txt读取正确歌名和专辑名。"""
    need_fix = any(GENERIC_TITLE_RE.search(t.get('title', '') or '') for t in tracks)
    album_title = album.get('title', '') or ''
    need_album = bool(GENERIC_TITLE_RE.search(album_title)) or album_title in ('', 'Unknown Title', '未知标题')
    if not need_fix and not need_album:
        return album, tracks
    # 找txt并解析曲目列表
    track_map = {}
    cur = dp
    for level in range(3):
        try:
            for f in os.listdir(cur):
                if f.lower().endswith('.txt'):
                    try:
                        t = read_text_auto(os.path.join(cur, f))
                        tm = parse_track_list_from_text(t)
                        if len(tm) > len(track_map):
                            track_map = tm
                    except Exception:
                        pass
        except Exception:
            pass
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    # 修正歌名
    if track_map and need_fix:
        for i, t in enumerate(tracks):
            no = i + 1
            if GENERIC_TITLE_RE.search(t.get('title', '') or '') and no in track_map:
                t['title'] = track_map[no]
    # 修正专辑名
    if need_album:
        inferred = infer_album_from_dir(dp)
        if inferred:
            album['title'] = inferred
    return album, tracks

def guess_lang(blob):
    return '纯音乐' if INSTR_RE.search(blob) else '国语'

def is_instrumental(artist, title, album, genre, lang, near_text=''):
    """综合判定是否为纯音乐/轻音乐/无人声。
    返回 (is_instr: bool, reason: str)。
    判定优先级：语种=纯音乐 > 风格=纯音乐/轻音乐/器乐 > 歌名含无人声标记 > 关键词匹配(INSTR_RE)。
    判定为纯音乐的曲目，转码时写入 INSTRUMENTAL=1 metadata，后续 worker 跳过人声分离和歌词对齐。
    """
    blob = ' '.join([artist or '', title or '', album or '', genre or '', near_text or ''])
    # 1. 语种已判定为纯音乐
    if lang == '纯音乐':
        return True, '语种=纯音乐'
    # 2. 风格为纯音乐/轻音乐/器乐
    if genre in ('纯音乐', '轻音乐', '器乐'):
        return True, f'风格={genre}'
    # 3. 歌名含明确的无人声标记
    if re.search(r'(伴奏|纯音乐|演奏|无人声|纯享|消音|卡拉OK|KTV|Instrumental|演奏版|纯音乐版)', title or '', re.I):
        return True, '歌名含无人声标记'
    # 4. 关键词匹配（INSTR_RE 已包含乐器名、纯音乐、轻音乐、New Age等）
    m = INSTR_RE.search(blob)
    if m:
        return True, f'关键词匹配: {m.group()}'
    return False, ''

# ---------- 命名规则全集（内置，后续直接运行即可） ----------
# 规则1：异常歌手名映射（论坛名/专辑名/宣传语 → 实际歌手或群星）
BAD_ARTIST_MAP = [
    (r'捌零音乐论坛', '董文华'),  # 董文华《发烧女声2》
    (r'民族之响韵.*发烧新境界', '石家环'),  # 巴乌专辑
    (r'倦鸟馀花论坛', '群星'),
    (r'炫音音乐论坛', '群星'),
    (r'炫音论坛', '群星'),
    (r'\[炫音音乐论坛\]纯音', '群星'),
    (r'枫情音乐论坛', '群星'),
    (r'gphifi', '群星'),
    (r'JPHiFi', '群星'),
    (r'3W点', '群星'),
    (r'一杯月色收藏', '群星'),
    (r'鑫达收藏', '群星'),
    (r'小雨收藏', '群星'),
    (r'残阳收藏', '群星'),
    (r'钻石珑收藏', '群星'),
    (r'收藏[】\]]*$', '群星'),
    (r'发烧民乐', '群星'),
    (r'发烧琴韵', '群星'),
    (r'发烧试音碟', '群星'),
    (r'网络男声', '群星'),
    (r'^DTS音乐?$', '群星'),
    (r'^群星·', '群星'),
    (r'^响·发烧', '群星'),
    (r'^音乐殿堂\d+', '群星'),
    (r'^未知艺术家$', '群星'),
    (r'^未知$', '群星'),
    (r'^Unknown Artist$', '群星'),
    (r'^Unknown$', '群星'),
]

# 规则2：风格规范化（英文/论坛名/宣传语 → 中文标准风格）
STYLE_NORMALIZE = {
    'Pop': '流行', 'POP': '流行', 'pop': '流行',
    'Classical': '古典', 'classical': '古典',
    'National Folk': '民族', 'national folk': '民族',
    'Pop－Folk': '民谣', 'Pop-Folk': '民谣',
    '炫音论坛': '流行', '倦鸟馀花论坛': '流行',
    '精品音乐尽在枫情音乐论坛': '流行',
    '深深D爱': '流行', '冰山一角收藏': '流行',
    '我要去听论坛': '流行', 'Other': '流行',
    'Unknown': '流行', '未知': '流行',
}

# 规则3：已知专辑曲目映射（网络查询确认的，按目录关键词匹配）
# 格式：(目录关键词正则, [(歌名, 歌手), ...])
KNOWN_ALBUM_TRACKS = [
    # 最新流行发烧金曲 DSD（13首）
    (r'最新流行发烧金曲', [
        ("青花瓷", "沉千琦"), ("有没有人告诉你", "林子路"), ("香烟爱上火柴", "云儿非"),
        ("自由飞翔", "林子路"), ("只欠秋天", "沉千琦"), ("今生最爱", "云儿非"),
        ("左眼皮跳跳", "沉千琦"), ("坐上火车去拉萨", "林子路"), ("等一分钟", "云儿非"),
        ("有一种爱叫做放手", "林子路"), ("别说你还爱着我", "云儿非"),
        ("对不起我的最爱", "沉千琦"), ("不要在寂寞的时候说爱我", "林子路"),
    ]),
    # 喜多郎 敦煌（9首）
    (r'喜多郎.*敦煌', [
        ("风神", "喜多郎"), ("海市蜃楼", "喜多郎"), ("巡礼之旅", "喜多郎"),
        ("砂之神", "喜多郎"), ("敦煌的思念", "喜多郎"), ("飞翔", "喜多郎"),
        ("曼陀罗", "喜多郎"), ("道", "喜多郎"), ("巡礼之旅II", "喜多郎"),
    ]),
    # 窦唯 八段锦（9首）
    (r'窦唯.*八段锦', [
        ("安早光阳", "窦唯"), ("半苑草", "窦唯"), ("十一庆1995", "窦唯"),
        ("六一儿1995", "窦唯"), ("五一游1995", "窦唯"), ("八一队正步1995", "窦唯"),
        ("照灯语录", "窦唯"), ("念", "窦唯"), ("阳光早安", "窦唯"),
    ]),
    # 窦唯 口音（8首）
    (r'窦唯.*口音', [
        ("师已", "窦唯"), ("口音1", "窦唯"), ("幻域", "窦唯"),
        ("尧帝遥桥图", "窦唯"), ("口音2", "窦唯"), ("杜十姑", "窦唯"),
        ("殃事", "窦唯"), ("口音3", "窦唯"),
    ]),
    # HI-FI极品靓声 CD1（16首）
    (r'极品靓声.*CD1', [
        ("伤不起", "马小郡"), ("今生缘", "雷婷"), ("滴答", "佩佩"), ("女人泪", "孙露"),
        ("佛说", "何晟铭"), ("把爱深藏", "阿强"), ("对爱期待", "黄小琥"),
        ("相思雨", "央金兰泽"), ("爱的供养", "刘紫玲"), ("我们的歌谣", "张伟伽"),
        ("一生无悔", "高安"), ("三寸天堂", "马小郡"), ("重来", "王子月"),
        ("万物生", "萨顶顶"), ("吻你", "龚玥"), ("漂亮的姑娘就要嫁人啦", "周虹"),
    ]),
    # HI-FI极品靓声 CD2（17首）
    (r'极品靓声.*CD2', [
        ("因为爱情", "南妮"), ("死而无憾", "刘科"), ("春天里", "阿强"),
        ("爱的供养", "邓杰"), ("老男孩", "阿强"), ("偷偷的哭", "雷婷"),
        ("等一个晴天", "陈影"), ("红尘情歌", "黑鸭子"), ("很有味道", "陈洁仪"),
        ("毒药", "雨天"), ("小三", "邓杰"), ("莲心", "钟明秋"),
        ("走天涯", "降央卓玛"), ("爱上草原爱上你", "龚玥"),
        ("别用下辈子安慰我", "陈瑞"), ("说再见不应该在秋天", "栗雅馨"),
        ("你把爱情给了谁", "江智民"),
    ]),
    # HI-FI极品靓声 CD3（17首）
    (r'极品靓声.*CD3', [
        ("等不到的爱", "钟明秋"), ("梦中的额吉", "罗海英"), ("大声唱", "凤凰传奇"),
        ("无法原谅", "雨天"), ("赤裸离开", "艾迪"), ("奔向你", "钟明秋"),
        ("我从雪山来", "龚玥"), ("不想回家的女人", "大哲"),
        ("梦的翅膀受了伤", "段玫梅"), ("漂亮的姑娘就要嫁人啦", "龙梅子"),
        ("我在乎的是你", "大哲"), ("缘分惹的祸", "涓子"), ("雨花石", "李雨儿"),
        ("云朵", "云朵"), ("恩惠", "萨顶顶"), ("最后一次", "周虹"),
        ("别再说", "张玮伽"),
    ]),
]

# 在路上发烧升级版20CD（完整曲目，按CD编号匹配）
ZAILUSHANG_TRACKS = {
    1: ["渡口","踢踏舞开场","低音大提琴","现场乐队","敲响我的铃铛","弥撒","带我逃离","走自己的喜欢的路","万宝路","给月亮上颜色","我唯一的爱","萨克斯","斯卡布罗集市","昨日重现","心之寻","狼"],
    2: ["一号女声低音测试","妖娆新疆","低音提琴","天国的女儿","老鹰之歌","写给海洋","卡萨布兰卡","想念妈妈","流浪之歌","流濑小镇","告别时刻","梁祝","新的世界","奥兰多","节奏之鼓","左右测试超逼真音源定位"],
    3: ["有多少爱可以重来","死你十分泪七分","大约在冬季","让我一次爱个够","深情难了","凡人歌","伤心1999","囚鸟","特别的爱给特别的你","拯救","白天不懂夜的黑","走过咖啡屋","我总与失去了你","最熟悉的陌生人","一千个伤心的理由"],
    4: ["伤痕","老情歌","新不了情","盛夏的果实","我等到花儿也谢了","爱一个人好难","执迷不悔","约定","味道","一天一点爱恋","恋曲1990","潇洒走一回","不装饰你的梦","一起走过的日子","只要你过得比我好"],
    5: ["一路上有你","在我心里从此有个你","那天晚上","错过的情人","说再见不应该在秋天","一切都是为爱","其实我很在乎你","不是因为寂寞才想你","在乎你一分一秒","爱过的你还在我心里","看透爱情看透你","我要用心的告诉你","爱在秋天的童话","为爱伤心为你痛","爱上你等于爱上了错"],
    6: ["在路上","有没有人告诉你","爱上负心的人","全世界最伤心的人","另一种乡愁","做你的爱人","你把爱情给了谁","擦肩而过","缘分五月","爱上你是一个错","真的不愿再把你想起","你的泪会说谎","为爱放弃自由","没有你我真的好孤单","你怎么舍得让我掉眼泪"],
    7: ["致青春","断桥离情","伤了心的女人怎么了","最痛的人","哭笑不得","一首心歌","我曾经那么接近幸福","风吹麦浪","春年花开","中国范儿","你抱着我哭","我知道你也很想念","又见山里红","一万个舍不得","今生无缘来生再聚"],
    8: ["花桥流水","想你的夜","那时雨","滴答","谁是我的郎","如果没有你","伤不起","小白脸","流浪","十一年","老男孩","心痛2013","一生无悔","我爱你胜过你爱我","等你等了那么久"],
    9: ["风吹麦浪","火火的姑娘","把酒问青天","妹妹妹妹美美美","老公是别人的情人","妹妹的酒","我是歌手","借点情借点爱","又见山里红","一万个舍不得","老婆最大","正能量"],
    10: ["求求你给点爱","爱情主演","红颜为谁红","多情伤别离","恨天恨地恨自己","羞答答的姑娘我爱你","一个女人的寂寞","心中的好姑娘","微信情妹妹","男大当红女大当嫁","朋友的酒","江南Style"],
    11: ["爱情这杯酒谁喝都得醉","有点舍不得","我的歌声里","我爱你胜过你爱我","红尘情歌","三寸天堂","情歌好听却难唱","缘分惹的祸","等不到的爱","没人心疼的滋味","爱上他的人","我最亲爱的","梦的翅膀受了伤","会受伤的人只有一种可能","漂亮的姑娘就要嫁人了"],
    12: ["那些年","新贵妃醉酒","滴答","你是我一生的知己","伤不起","依然爱你","我们的歌遥","因为爱情","相爱的泪水","寂静的天空","爱的供养","老男孩","荷塘月色","没那么简单","爱就是这样简单"],
    13: ["单身情歌","女人花","用心良苦","没有情人的情人节","我的未来不是梦","橄榄树","张三的歌","征服","过火","回家","记事本","心太软","城里的月光","别问我是谁","你知道我在等你吗"],
    14: ["忘情水","水手","听海","十年","独角戏","浪人情歌","霸王别姬","从头再来","第一次","三万英尺","宝贝对不起","叫你一声My Love","让我喜欢让我忧","九百九十九朵玫瑰","你把我灌醉"],
    15: ["Everybody People 每个人","Pina Colada Boy 冰镇果汁朗姆酒男孩","Funky 惊恐的","It's My Party Radio Edit 我的派对编曲","Never Underestimate A Gifl 永远不要低估女孩","Hero 英雄","Koonichi Wa 丹麦舞曲","Come Baby 来，宝贝","Vostochnie Skazki 天方夜谭","Don't Play Nice 别玩得那么爽","Lubov 亲爱的","Walk Away Tonight 夜晚走开","Nos Couleurs 我们的颜色","It's A Dream 这是一个梦想","Clue 俱乐部","Wut U Want 你想要的","Du Hast Den Schonsten Arsch Der Welt 你拥有世上最美的PP"],
    16: ["Teenage Life 少年时代","Why Don't You Play It Louder 你为何不大声播放","NO Good Time 不是好时机","Ops Jaime Pas Langlais 海梅，帕斯兰格拉行动","Ce Frumoasa E Iubirea 美丽的爱情","Just Started Being Bad 不好的开始","Call From Babylon 巴比伦来电","Temptation 诱惑","Feel You Man 感觉你是绅士","Doar Cu Tine 只为你","Come Baby Imax 来，宝贝","Shy Guy 害羞的人","Chiki Chiki 奇克奇克","Didi 迪迪","Bumbumok 彭彭姆克","Buckle Up Chuggeluck Heaven 飙向天堂","No Games 无游戏"],
    17: ["约翰尼乙","期待但不要触摸","狂热","原宿女孩","漫漫长夜","一步一步地","今晚叫你","肮脏的欲望","在你我之间","只是舞蹈","如何让你心动","圣诞快乐 劳伦斯先生","与我们共度","聚光灯","商业","年轻气盛","危险","比莉，简"],
    18: ["理想剂量","当我靠近你","今晚在空中","了解你真实的谎言","失去阳光","美梦成真","假面游行","加州旅馆","等待的游戏","随风飘荡","期待好转那一刻","加州梦","日升之舞","尽在不言中","金色田野","这个杀手不太冷"],
    19: ["秘密祈祷","沉静","和谐之旅","内在和谐","呼吸","日出","回归山川","渴望","心静如水","日落夕阳","远古的清晨","风的气息"],
    20: ["爱上尤加利","为你而歌","另一个领地","迷情森林","晨露荷珠","欢乐的田野","陌生地带","浸润回忆","飘柔的莲叶","神秘沙滩","彼岸","天空之梦"],
}

def fix_bad_artist(artist, rel_path=''):
    """规则1：修复异常歌手名。传入歌手和目录路径，返回修正后的歌手。"""
    if not artist:
        return '群星'
    # 先按目录关键词匹配已知专辑
    for pattern, tracks in KNOWN_ALBUM_TRACKS:
        if re.search(pattern, rel_path):
            # 已知专辑统一用曲目映射里的歌手，这里只返回通用值
            return artist
    # 在路上系列
    if re.search(r'在路上CD\d+', rel_path):
        return '群星'
    # 按异常模式匹配
    for pattern, target in BAD_ARTIST_MAP:
        if re.search(pattern, artist, re.I):
            return target
    return artist

def normalize_style(style):
    """规则2：规范化风格字段。"""
    if not style:
        return '流行'
    # 精确匹配
    if style in STYLE_NORMALIZE:
        return STYLE_NORMALIZE[style]
    # 包含论坛/网站/收藏等关键词
    if re.search(r'(论坛|收藏|http|www\.|精品音乐|我要去听|深深D爱)', style, re.I):
        return '流行'
    return style

def apply_known_album_tracks(rel_path, tracks):
    """规则3：对已知专辑，用网络确认的曲目替换Trackxx/音轨xx。
    传入目录相对路径和cue解析的tracks列表，原地修改。"""
    # 在路上系列
    m = re.search(r'在路上CD(\d+)', rel_path)
    if m:
        cd = int(m.group(1))
        if cd in ZAILUSHANG_TRACKS:
            known = ZAILUSHANG_TRACKS[cd]
            for i, t in enumerate(tracks):
                if i < len(known) and GENERIC_TITLE_RE.search(t.get('title', '') or ''):
                    t['title'] = known[i]
                    t['performer'] = '群星'
            return tracks
    # 其他已知专辑
    for pattern, known_tracks in KNOWN_ALBUM_TRACKS:
        if re.search(pattern, rel_path):
            for i, t in enumerate(tracks):
                if i < len(known_tracks) and GENERIC_TITLE_RE.search(t.get('title', '') or ''):
                    title, artist = known_tracks[i]
                    t['title'] = title
                    t['performer'] = artist
            return tracks
    return tracks

# 规则4：网络自动查询修复说明（遇到Trackxx且txt和已知专辑都无法匹配时）
# 搜索优先级：美篇(meipian.cn) → 网易云(163.com) → QQ音乐(qq.com) → 豆瓣(douban.com) → 串串烧论坛(2008dj.com) → 通用搜索
# 查询到后更新 KNOWN_ALBUM_TRACKS 字典，后续自动匹配
NETWORK_QUERY_PRIORITY = ['meipian.cn', '163.com', 'qq.com', 'douban.com', '2008dj.com', 'general']

def build_name(artist, title, lang, style):
    """四段命名：歌手-歌名-语种-风格.flac（已去掉序号和专辑名）。"""
    # 清理歌名开头的序号前缀，如 "14、" "01." "1-" "01 "
    clean_title = re.sub(r'^\d{1,3}\s*[、.．\-—\s]\s*', '', title or '')
    clean_title = re.sub(r'^第\d{1,3}[首曲目]\s*', '', clean_title)
    seg = [clean_seg(artist), clean_seg(clean_title), clean_seg(lang), clean_seg(style)]
    name = '-'.join(seg)
    if len(name.encode('utf-8')) > 200:
        over = len(name.encode('utf-8')) - 200
        seg[1] = seg[1][:max(1, len(seg[1]) - over // 2 - 1)]
        name = '-'.join(seg)
    return name + '.flac'

# 版本说明关键词（括号里包含这些则不是歌手名）
_PAREN_VERSION_KW = ['版','原创','国语','粤语','英语','日语','韩语','伴奏','Demo','Remix','Live',
    '对比','新编','精选','现场','演唱会','卡拉OK','KTV','纯音乐','演奏','演奏版',
    '二胡','古筝','钢琴','小提琴','大提琴','吉他','萨克斯','笛子','洞箫','古琴',
    '琵琶','扬琴','唢呐','马头琴','手风琴','口琴','架子鼓','鼓','贝斯','电子琴',
    '双电子琴','中提琴','低音提琴','长笛','短笛','单簧管','双簧管','小号','长号',
    '圆号','大号','定音鼓','木琴','钟琴','管风琴','竖琴','键盘','合成器','风琴',
    '童声','合唱','齐唱','领唱','伴唱','和声','独白','旁白','朗诵','对白','插曲',
    '主题曲','片头曲','片尾曲']

def extract_artist_from_title(title, artist):
    """当歌手为群星时，从歌名括号中提取实际歌手名。
    返回 (new_title, new_artist)；无需提取则返回 (title, artist)。"""
    if artist not in ('群星', 'Various Artists', 'VA'):
        return title, artist
    m = re.search(r'[（(](.*?)[）)]', title or '')
    if not m:
        return title, artist
    content = m.group(1).strip()
    if any(kw in content for kw in _PAREN_VERSION_KW):
        return title, artist
    # 处理"童声：牛湘茗"格式
    if '：' in content or ':' in content:
        parts = re.split(r'[：:]', content, 1)
        if len(parts) == 2 and parts[1].strip():
            new_artist = parts[1].strip()
            new_title = (title[:m.start()] + title[m.end():]).strip(' -_·')
            if new_title:
                return new_title, new_artist
    # 处理"降央卓玛VS小曾"或普通人名
    if len(content) <= 15 and re.match(r'^[\u4e00-\u9fa5\s&·、VSvs\.]+$', content):
        new_title = (title[:m.start()] + title[m.end():]).strip(' -_·')
        if new_title:
            return new_title, content
    return title, artist

# ---------- 扫描整轨任务 ----------
WHOLE_EXTS = ('.wav', '.ape', '.flac', '.tta', '.wv')

def find_cue_jobs(root):
    """扫描整轨目录：目录里有 .cue 且 cue 为单 FILE 格式（非多FILE单曲索引）。"""
    jobs = {}
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d.lower() not in ('all-flacs', 'separated', '_flac_sample')]
        cues = [f for f in fns if f.lower().endswith('.cue')]
        if not cues:
            continue
        # 检查是否存在单FILE的cue（整轨分轨cue）；多FILE的是单曲索引，留给single模式
        whole_cues = []
        for cue in cues:
            try:
                text = read_text_auto(os.path.join(dp, cue))
                file_count = len(re.findall(r'^\s*FILE\s+', text, re.M | re.I))
                if file_count == 1:
                    whole_cues.append(cue)
            except Exception:
                pass
        if not whole_cues:
            continue
        whole = [f for f in fns if f.lower().endswith(WHOLE_EXTS)]
        if not whole:
            continue
        jobs[dp] = {'dir': dp, 'whole': whole, 'cues': whole_cues, 'allfiles': fns}
    return jobs

def pick_whole(job, cue_name):
    """选择与 cue 对应的整轨文件：优先同名，其次选最大的音频文件。"""
    base = os.path.splitext(cue_name)[0]
    dp = job['dir']
    # 1. 与 cue 同名（不含扩展名）
    for w in job['whole']:
        if os.path.splitext(w)[0].lower() == base.lower():
            return w
    # 2. 选最大的音频文件（整轨通常远大于单曲）
    best = None
    best_size = -1
    for w in job['whole']:
        try:
            sz = os.path.getsize(os.path.join(dp, w))
            if sz > best_size:
                best_size = sz
                best = w
        except Exception:
            pass
    if best:
        return best
    return job['whole'][0]

# ---------- 单张专辑处理（worker 进程执行） ----------
def process_album(args):
    dp, job, root, out_root, do_exec = args
    r = {'dir': dp, 'ok': 0, 'skip': 0, 'fail': [], 'tracks': 0, 'note': ''}
    if not job['cues']:
        r['note'] = 'NO_CUE'
        return r
    cue_path = os.path.join(dp, job['cues'][0])
    try:
        album, tracks = parse_cue(read_text_auto(cue_path))
    except Exception as e:
        r['fail'].append('CUE_PARSE:' + str(e))
        return r
    # 自动修正：cue歌名是Trackxx/音轨xx/未知标题时，从同级/上级txt读取正确歌名
    album, tracks = fix_tracks_from_txt(dp, album, tracks)
    # 规则3：对已知专辑，用网络确认的曲目替换Trackxx
    rel = os.path.relpath(dp, root)
    tracks = apply_known_album_tracks(rel, tracks)
    # 记录仍需网络修复的Trackxx专辑
    generic_tracks = [t for t in tracks if GENERIC_TITLE_RE.search(t.get('title', '') or '')]
    if generic_tracks and do_exec:
        try:
            import json
            fix_log = os.path.join(out_root, '_track_to_fix.jsonl')
            record = {
                'dir': dp,
                'album': album.get('title', '') or os.path.basename(dp),
                'artist': album.get('performer', '') or '',
                'track_count': len(tracks),
                'generic_count': len(generic_tracks),
                'time': time.strftime('%Y-%m-%d %H:%M:%S'),
            }
            with open(fix_log, 'a', encoding='utf-8') as fl:
                fl.write(json.dumps(record, ensure_ascii=False) + '\n')
        except Exception:
            pass
    whole_name = pick_whole(job, job['cues'][0])
    whole_path = os.path.join(dp, whole_name)
    txt_artist = artist_from_txt(dp)
    near = os.path.basename(dp) + ' ' + os.path.basename(os.path.dirname(dp))
    rel = os.path.relpath(dp, root)
    out_dir = os.path.join(out_root, rel)
    r['album'] = album.get('title', '')
    r['tracks'] = len(tracks)
    if not do_exec:
        return r
    os.makedirs(out_dir, exist_ok=True)
    for t in tracks:
        artist = t['performer'] or album['performer'] or txt_artist or '未知'
        title = t['title'] or '未知'
        # 从歌名括号中提取实际歌手名（群星合辑）
        title, artist = extract_artist_from_title(title, artist)
        # 规则1：修复异常歌手名（论坛名/专辑名/未知 → 实际歌手或群星）
        artist = fix_bad_artist(artist, rel)
        lang = guess_lang(' '.join([artist, title, album.get('title', ''), near]))
        style = guess_style(t['genre'] or album.get('genre', ''), near)
        # 规则2：规范化风格（英文/论坛名 → 中文标准风格）
        style = normalize_style(style)
        # 规则5：纯音乐/轻音乐/无人声 判定 → 写入 INSTRUMENTAL metadata，后续跳过人声分离
        is_instr, instr_reason = is_instrumental(artist, title, album.get('title', ''), style, lang, near)
        comment = f'Original: {whole_name}'
        if is_instr:
            comment += f'; Instrumental: 1 ({instr_reason})'
        fn = build_name(artist, title, lang, style)
        out = os.path.join(out_dir, fn)
        if os.path.exists(out) and os.path.getsize(out) > 0:
            r['skip'] += 1
            continue
        cmd = [FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-i', whole_path]
        if t['index'] is not None:
            cmd += ['-ss', '%.3f' % t['index']]
        if t['end'] is not None:
            cmd += ['-to', '%.3f' % t['end']]
        cmd += ['-map', '0:a', '-c:a', 'flac', '-compression_level', '5',
                '-metadata', 'TITLE=' + (re.sub(r'^\d{1,3}[\.\、\s\-]\s*', '', title) or ''),
                '-metadata', 'ARTIST=' + artist,
                '-metadata', 'ALBUM=' + (album.get('title', '') or ''),
                '-metadata', 'GENRE=' + style,
                '-metadata', 'LANGUAGE=' + lang,
                '-metadata', 'TRACKNUMBER=' + t['no'],
                '-metadata', 'INSTRUMENTAL=' + ('1' if is_instr else '0'),
                '-metadata', 'COMMENT=' + comment]
        if album.get('date'):
            cmd += ['-metadata', 'DATE=' + album['date']]
        cmd += [out]
        try:
            p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if p.returncode != 0 or not (os.path.exists(out) and os.path.getsize(out) > 0):
                r['fail'].append(fn + ' :: ' + p.stderr.decode('utf-8', 'replace')[:300])
                continue
            # 解码质检（无 ffprobe 时用 ffmpeg 解码到 null）
            ok, msg = verify_ok(out)
            if not ok:
                r['fail'].append(fn + ' :: VERIFY ' + msg)
            else:
                r['ok'] += 1
        except Exception as e:
            r['fail'].append(fn + ' :: ' + str(e)[:200])
    return r

# ---------- 单曲模式 ----------
SINGLE_EXTS = ('.wav', '.ape', '.flac', '.tta', '.wv', '.m4a')

def find_single_jobs(root):
    """扫描所有单曲文件（排除整轨CDImage和输出目录）。返回 {文件路径: 元信息}。"""
    jobs = {}
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d.lower() not in ('all-flacs', 'separated', '_flac_sample')]
        # 跳过含整轨的目录（整轨由cue模式处理）
        has_whole = any(re.match(r'^cdimage\.(ape|wav|flac)$', f, re.I) for f in fns)
        if has_whole:
            continue
        for f in fns:
            if f.lower().endswith(SINGLE_EXTS):
                fp = os.path.join(dp, f)
                jobs[fp] = {'path': fp, 'dir': dp, 'name': f}
    return jobs

def parse_single_filename(fname):
    """从单曲文件名解析序号、歌手、歌名。返回(no, artist, title)。"""
    base = os.path.splitext(fname)[0]
    # 常见格式: "01.歌手 - 歌名" / "01-歌手-歌名" / "歌手 - 歌名" / "歌名"
    no = ''
    m = re.match(r'^(\d{1,3})[\.\-\s_]+(.+)$', base)
    if m:
        no = m.group(1).zfill(2)
        rest = m.group(2)
    else:
        rest = base
    # 用 " - " 或 "-" 分割歌手和歌名
    parts = re.split(r'\s+-\s+|\s+-\s*|\s*-\s+', rest, maxsplit=1)
    if len(parts) == 2 and parts[0].strip() and parts[1].strip():
        return no, parts[0].strip(), parts[1].strip()
    # 用 "-" 分割（无空格）
    parts = rest.split('-', 1)
    if len(parts) == 2 and parts[0].strip() and parts[1].strip():
        return no, parts[0].strip(), parts[1].strip()
    return no, '', rest.strip()

def process_single(args):
    fp, job, root, out_root, do_exec = args
    r = {'file': fp, 'ok': 0, 'skip': 0, 'fail': [], 'note': ''}
    no, artist, title = parse_single_filename(job['name'])
    dp = job['dir']
    album = os.path.basename(dp)
    parent = os.path.basename(os.path.dirname(dp))
    near = album + ' ' + parent
    txt_artist = artist_from_txt(dp)
    artist = artist or txt_artist or '未知'
    rel = os.path.relpath(dp, root)
    # 规则1：修复异常歌手名
    artist = fix_bad_artist(artist, rel)
    lang = guess_lang(' '.join([artist, title, album, near]))
    style = guess_style('', near)
    # 规则2：规范化风格
    style = normalize_style(style)
    # 规则5：纯音乐/轻音乐/无人声 判定 → 写入 INSTRUMENTAL metadata
    is_instr, instr_reason = is_instrumental(artist, title, album, style, lang, near)
    comment = f'Original: {job["name"]}'
    if is_instr:
        comment += f'; Instrumental: 1 ({instr_reason})'
    out_dir = os.path.join(out_root, rel)
    fn = build_name(artist, title or '未知', lang, style)
    out = os.path.join(out_dir, fn)
    if not do_exec:
        r['note'] = 'DRY'
        return r
    if os.path.exists(out) and os.path.getsize(out) > 0:
        r['skip'] = 1
        return r
    os.makedirs(out_dir, exist_ok=True)
    cmd = [FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-i', fp,
           '-map', '0:a', '-c:a', 'flac', '-compression_level', '5',
           '-metadata', 'TITLE=' + (title or ''),
           '-metadata', 'ARTIST=' + artist,
           '-metadata', 'ALBUM=' + album,
           '-metadata', 'GENRE=' + style,
           '-metadata', 'LANGUAGE=' + lang,
           '-metadata', 'TRACKNUMBER=' + (no or '00'),
           '-metadata', 'INSTRUMENTAL=' + ('1' if is_instr else '0'),
           '-metadata', 'COMMENT=' + comment,
           out]
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if p.returncode != 0 or not (os.path.exists(out) and os.path.getsize(out) > 0):
            r['fail'].append(fn + ' :: ' + p.stderr.decode('utf-8', 'replace')[:300])
            return r
        ok, msg = verify_ok(out)
        if not ok:
            r['fail'].append(fn + ' :: VERIFY ' + msg)
        else:
            r['ok'] = 1
    except Exception as e:
        r['fail'].append(fn + ' :: ' + str(e)[:200])
    return r

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default=DEFAULT_ROOT)
    ap.add_argument('--out-root', default='')
    ap.add_argument('--mode', default='cue', choices=['cue', 'single'])
    ap.add_argument('--workers', type=int, default=8)
    ap.add_argument('--smb-share', default=r'\\192.168.3.80\music')
    ap.add_argument('--smb-user', default='')
    ap.add_argument('--smb-pass', default='')
    ap.add_argument('--only', default='', help='只处理路径含该子串的专辑')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--dry', action='store_true')
    args = ap.parse_args()
    if not args.out_root:
        args.out_root = os.path.join(args.root, 'all-flacs')

    ensure_share(args.smb_share, args.smb_user, args.smb_pass)
    log('ROOT=', args.root, ' 存在=', os.path.exists(args.root))
    log('OUT =', args.out_root, ' ffmpeg=', FFMPEG)

    if args.mode == 'single':
        jobs = find_single_jobs(args.root)
        items = sorted(jobs.items())
        if args.only:
            items = [(fp, j) for fp, j in items if args.only in fp]
        if args.limit:
            items = items[:args.limit]
        log('单曲文件数=', len(items))
        task_args = [(fp, j, args.root, args.out_root, not args.dry) for fp, j in items]
        processor = process_single
        label = '单曲'
    else:
        jobs = find_cue_jobs(args.root)
        items = sorted(jobs.items())
        if args.only:
            items = [(dp, j) for dp, j in items if args.only in dp]
        if args.limit:
            items = items[:args.limit]
        log('整轨目录数=', len(items))
        task_args = [(dp, j, args.root, args.out_root, not args.dry) for dp, j in items]
        processor = process_album
        label = '专辑'

    if args.dry:
        if args.mode == 'single':
            log('DRY 单曲数=%d' % len(items))
        else:
            tot_tracks = 0
            nocue = 0
            for a in task_args:
                r = process_album(a)
                tot_tracks += r['tracks']
                if r['note'] == 'NO_CUE':
                    nocue += 1
            log('DRY 有cue专辑=%d 无cue=%d 总曲目=%d' % (len(items) - nocue, nocue, tot_tracks))
        return

    os.makedirs(args.out_root, exist_ok=True)
    log_path = os.path.join(args.out_root, '_convert_log.jsonl')
    fail_path = os.path.join(args.out_root, '_convert_failed.txt')
    t0 = time.time()
    sum_ok = sum_skip = sum_fail = done = 0
    with ProcessPoolExecutor(max_workers=args.workers) as ex, \
         open(log_path, 'a', encoding='utf-8') as lf:
        futs = {ex.submit(processor, a): a[0] for a in task_args}
        for fu in as_completed(futs):
            dp = futs[fu]
            done += 1
            try:
                r = fu.result()
            except Exception as e:
                log('[EXC]', dp, e)
                with open(fail_path, 'a', encoding='utf-8') as ff:
                    ff.write(dp + '\tEXC ' + str(e) + '\n')
                sum_fail += 1
                continue
            sum_ok += r['ok']; sum_skip += r['skip']; sum_fail += len(r['fail'])
            lf.write(json.dumps(r, ensure_ascii=False) + '\n'); lf.flush()
            if r['fail']:
                with open(fail_path, 'a', encoding='utf-8') as ff:
                    for x in r['fail']:
                        ff.write(dp + '\t' + x + '\n')
            if done % 20 == 0 or r['fail']:
                name = r.get('title') or r.get('album') or os.path.basename(dp)
                log('进度 %d/%d ok=%d skip=%d fail=%d 用时%.0fs  %s'
                    % (done, len(items), sum_ok, sum_skip, sum_fail, time.time() - t0, name))
    log('全部完成: ok=%d skip=%d fail=%d 总用时%.0f分钟'
        % (sum_ok, sum_skip, sum_fail, (time.time() - t0) / 60))

if __name__ == '__main__':
    main()
