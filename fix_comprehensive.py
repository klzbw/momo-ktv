# -*- coding: utf-8 -*-
"""综合修复：异常歌手名（收藏/论坛/网站）+ 歌名序号时长 + metadata。
遍历all-flacs，发现异常就重命名文件并重写metadata。"""
import os, re, subprocess, time
from concurrent.futures import ThreadPoolExecutor, as_completed

OUT = r'\\192.168.3.80\music\all-flacs'
FFMPEG = r'C:\ffmpeg\bin\ffmpeg.exe'
WORKERS = 15

# 异常歌手模式（匹配到则改为群星）
BAD_ARTIST_PATTERNS = [
    r'www', r'http', r'\.com', r'\.cn', r'\.net', r'JPHiFi', r'gphifi',
    r'论坛', r'收藏', r'精品音乐', r'一杯月色', r'鑫达', r'小雨', r'残阳',
    r'钻石珑', r'炫音', r'倦鸟', r'枫情', r'捌零', r'我要去听',
]

VERSION_KW = ['版','国语','粤语','英语','日语','韩语','伴奏','Demo','Remix','Live',
    '现场','演唱会','卡拉OK','KTV','纯音乐','演奏','二胡','古筝','钢琴','小提琴',
    '大提琴','吉他','萨克斯','笛子','洞箫','古琴','琵琶','扬琴','唢呐','马头琴',
    '童声','合唱','插曲','主题曲','片头曲','片尾曲','DSD','HQCD','K2HD']

def is_bad_artist(artist):
    for p in BAD_ARTIST_PATTERNS:
        if re.search(p, artist, re.I):
            return True
    return False

def clean_title(title):
    """清理歌名：序号前缀、时长后缀、网站信息。"""
    t = title
    # 去掉序号前缀：07、01.、1-、1、等
    t = re.sub(r'^\d{1,3}[\.\、\s\-—]\s*', '', t)
    t = re.sub(r'^第\d{1,3}[首曲目]\s*', '', t)
    # 去掉时长后缀：4'58、4:58、04:58
    t = re.sub(r"\s*\d{1,2}[':：]\d{2}\s*$", '', t)
    t = re.sub(r"\s*\d{1,2}分\d{1,2}秒\s*$", '', t)
    # 去掉网站信息括号
    t = re.sub(r'[【\[\(][^】\]\)]*(?:www|http|\.com|\.cn|\.net|JPHiFi|gphifi|论坛|收藏)[^】\]\)]*[】\]\)]', '', t, flags=re.I)
    # 从括号提取歌手（如果有）
    artist_in_paren = ''
    m = re.search(r'[（(](.*?)[）)]', t)
    if m:
        content = m.group(1).strip()
        if not any(kw in content for kw in VERSION_KW) and len(content) <= 15 and re.search(r'[\u4e00-\u9fa5]', content):
            artist_in_paren = content
            t = (t[:m.start()] + t[m.end():]).strip(' -_·')
    t = re.sub(r'\s+', ' ', t).strip(' -_·')
    return t, artist_in_paren

def infer_album(fp):
    parts = fp.split(os.sep)
    for p in reversed(parts[:-1]):
        if re.search(r'(CD\d|CD[A-Z]|DISC|专辑|《|》|\[)', p):
            album = re.sub(r'\[(WAV|APE|FLAC|DTS|DSD|HQCD|K2HD|XRCD|LP|黑胶)[^\]]*\]', '', p, flags=re.I)
            album = re.sub(r'[（(][^）)]*(WAV|APE|FLAC|DTS|DSD|整轨|分轨|无损)[^）)]*[）)]', '', album, flags=re.I)
            return album.strip(' -_·')
    if len(parts) >= 2:
        return parts[-2].strip(' -_·')
    return ''

def fix_file(fp):
    fn = os.path.basename(fp)
    if not fn.endswith('.flac'):
        return False, 'skip'
    name = fn[:-5]
    parts = name.split('-', 3)
    if len(parts) != 4:
        return False, 'bad format'
    artist, title, lang, style = parts
    changed = False
    # 修复异常歌手
    if is_bad_artist(artist):
        artist = '群星'
        changed = True
    # 清理歌名
    clean_t, paren_artist = clean_title(title)
    if clean_t != title:
        title = clean_t
        changed = True
    if paren_artist and artist == '群星':
        artist = paren_artist
        changed = True
    if not changed:
        return False, 'ok'
    # 规范化风格
    style_map = {'Other': '流行', 'Unknown': '流行', '未知': '流行', 'Pop': '流行',
                 'Classical': '古典', 'National Folk': '民族', 'POP': '流行'}
    if style in style_map:
        style = style_map[style]
    # 重命名文件
    new_fn = artist + '-' + title + '-' + lang + '-' + style + '.flac'
    new_fp = os.path.join(os.path.dirname(fp), new_fn)
    if new_fp != fp:
        if os.path.exists(new_fp):
            # 目标已存在，删除原文件（避免重复）
            try:
                os.remove(fp)
                return True, 'dup removed: ' + fn[:60]
            except:
                return False, 'dup exists'
        try:
            os.rename(fp, new_fp)
            fp = new_fp
        except Exception as e:
            return False, 'rename fail: ' + str(e)[:50]
    # 修复metadata
    album = infer_album(fp)
    tmp = fp + '.tmp.flac'
    cmd = [FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-i', fp,
           '-map', '0:a', '-c:a', 'copy',
           '-metadata', 'TITLE=' + title,
           '-metadata', 'ARTIST=' + artist,
           '-metadata', 'GENRE=' + style,
           '-metadata', 'LANGUAGE=' + lang]
    if album:
        cmd += ['-metadata', 'ALBUM=' + album]
    cmd.append(tmp)
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=30)
        if p.returncode != 0 or not os.path.exists(tmp) or os.path.getsize(tmp) == 0:
            return True, 'renamed, meta fail: ' + fn[:50]
        os.replace(tmp, fp)
        return True, 'fixed: ' + artist + ' - ' + title[:40]
    except Exception as e:
        if os.path.exists(tmp):
            try: os.remove(tmp)
            except: pass
        return True, 'renamed, meta err: ' + str(e)[:40]

def main():
    files = []
    print('扫描文件...')
    for dp, dns, fns in os.walk(OUT):
        for fn in fns:
            if fn.endswith('.flac'):
                files.append(os.path.join(dp, fn))
    print('共 ' + str(len(files)) + ' 个文件')
    t0 = time.time()
    fixed = 0
    failed = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(fix_file, fp): fp for fp in files}
        for i, fu in enumerate(as_completed(futs), 1):
            try:
                ok, msg = fu.result()
                if ok:
                    fixed += 1
                else:
                    failed += 1
            except Exception as e:
                failed += 1
            if i % 500 == 0:
                print('进度 %d/%d 已修复=%d 失败=%d 用时%.0fs' % (i, len(files), fixed, failed, time.time()-t0))
    print('完成: 已修复=%d 失败=%d 总用时%.1f分钟' % (fixed, failed, (time.time()-t0)/60))

if __name__ == '__main__':
    main()
