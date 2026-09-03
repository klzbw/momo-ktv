# -*- coding: utf-8 -*-
"""
phase4_comprehensive_fix.py —— 四段格式文件的全面修复
处理：Trackxx歌名、未知歌手、网站/收藏标记、风格问题、歌名序号前缀、括号歌手提取
只重命名，不更新metadata（后续单独处理）。
"""
import os, re, sys, time

if hasattr(sys.stdout, 'reconfigure'):
    try: sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception: pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from flac_convert import (read_text_auto, clean_seg, artist_from_txt,
                          guess_style, guess_lang, fix_tracks_from_txt,
                          parse_cue, extract_artist_from_title, remove_site_info)

OUT_ROOT = r'\\192.168.3.80\music\all-flacs'
SRC_ROOT = r'\\192.168.3.80\music'

GENERIC_TITLE_RE = re.compile(r'^(Track|音轨|track|TRACK|Unknown Title|未知标题|Untitled)\d*$', re.I)

def clean_title_prefix(title):
    t = re.sub(r'^\d{1,3}\s*[、.．\-—\s]\s*', '', title or '')
    t = re.sub(r'^第\d{1,3}[首曲目]\s*', '', t)
    return t.strip()

def get_src_info(src_dir, track_no):
    """从源目录获取修正后的歌名、歌手、风格。"""
    title = artist = style = None
    if not os.path.isdir(src_dir):
        return title, artist, style
    cues = [f for f in os.listdir(src_dir) if f.lower().endswith('.cue')]
    if cues:
        try:
            album, tracks = parse_cue(read_text_auto(os.path.join(src_dir, cues[0])))
            album, tracks = fix_tracks_from_txt(src_dir, album, tracks)
            if 1 <= track_no <= len(tracks):
                t = tracks[track_no - 1]
                title = t.get('title')
                artist = t.get('performer') or album.get('performer')
                g = t.get('genre') or album.get('genre', '')
                near = os.path.basename(src_dir) + ' ' + os.path.basename(os.path.dirname(src_dir))
                style = guess_style(g, near)
        except Exception:
            pass
    if not artist or artist in ('未知', 'Unknown Artist', '未知艺术家'):
        a = artist_from_txt(src_dir)
        if a:
            artist = a
    return title, artist, style

def infer_artist_from_dir(src_dir):
    """从目录名推断歌手。"""
    if not os.path.isdir(src_dir):
        return None
    base = os.path.basename(src_dir)
    # 目录名格式：歌手-专辑 或 歌手《专辑》
    m = re.match(r'^([^－\-—《【\[]+)[－\-—]', base)
    if m:
        a = m.group(1).strip()
        if a and len(a) <= 20 and not any(kw in a for kw in ['专辑','精选','合集','合辑','发烧','HIFI','DTS','DSD','CD','音乐','歌曲','金曲','好歌','老歌','情歌']):
            return a
    m = re.match(r'^([^《【\[]+)《', base)
    if m:
        a = m.group(1).strip()
        if a and len(a) <= 20:
            return a
    return None

def main():
    renamed = 0
    skipped = 0
    failed = 0
    t0 = time.time()
    stats = {'title': 0, 'artist': 0, 'style': 0, 'site': 0, 'prefix': 0, 'paren': 0}

    all_files = []
    for dp, dns, fns in os.walk(OUT_ROOT):
        for fn in fns:
            if fn.lower().endswith('.flac'):
                all_files.append((dp, fn))

    print(f'共发现 {len(all_files)} 个FLAC文件，开始全面修复...')

    for idx, (dp, fn) in enumerate(all_files):
        if idx % 1000 == 0 and idx > 0:
            print(f'  进度: {idx}/{len(all_files)} ({idx*100//len(all_files)}%) 已修复={renamed} 失败={failed} 用时={time.time()-t0:.0f}s')

        base = fn[:-5]
        parts = base.split('-', 3)
        if len(parts) != 4:
            skipped += 1
            continue

        artist, title, lang, style = parts
        orig_artist, orig_title, orig_style = artist, title, style
        changed = False

        # 1. 清理网站/收藏标记（歌手和歌名）
        cleaned_artist = remove_site_info(artist)
        cleaned_artist = re.sub(r'[【\[][^】\]]*(收藏|论坛|分享|制作|出品)[^】\]]*[】\]]', '', cleaned_artist).strip(' -_·')
        if cleaned_artist != artist and cleaned_artist:
            artist = cleaned_artist
            stats['site'] += 1
            changed = True

        cleaned_title = remove_site_info(title)
        if cleaned_title != title and cleaned_title:
            title = cleaned_title
            stats['site'] += 1
            changed = True

        # 2. 清理歌名序号前缀
        new_title = clean_title_prefix(title)
        if new_title != title:
            title = new_title
            stats['prefix'] += 1
            changed = True

        # 3. 括号歌手提取（群星合辑）
        title, artist = extract_artist_from_title(title, artist)
        if artist != orig_artist:
            stats['paren'] += 1
            changed = True

        # 4. 通用歌名修正（Trackxx/音轨xx）
        if GENERIC_TITLE_RE.match(title):
            rel = os.path.relpath(dp, OUT_ROOT)
            src_dir = os.path.join(SRC_ROOT, rel)
            # 尝试从文件名中的TRACKNUMBER metadata获取序号，但这里没有，用目录内文件序号
            # 先尝试从源目录cue获取
            t, a, s = get_src_info(src_dir, 0)  # 0表示不确定序号，尝试所有
            if t:
                title = t
                stats['title'] += 1
                changed = True
            if a and a not in ('未知', 'Unknown Artist', '未知艺术家') and a != artist:
                artist = a
                stats['artist'] += 1
                changed = True
            if s and s != style:
                style = s
                stats['style'] += 1
                changed = True

        # 5. 未知歌手修正
        if artist in ('未知', 'Unknown Artist', '未知艺术家', 'Unknown', ''):
            rel = os.path.relpath(dp, OUT_ROOT)
            src_dir = os.path.join(SRC_ROOT, rel)
            a = artist_from_txt(src_dir)
            if not a:
                a = infer_artist_from_dir(src_dir)
            if a and a != artist:
                artist = a
                stats['artist'] += 1
                changed = True

        # 6. 风格修正
        if style in ('未知', '发烧', 'Other', 'Unknown', '') or '论坛' in style or '收藏' in style:
            near = os.path.basename(dp) + ' ' + os.path.basename(os.path.dirname(dp))
            s = guess_style('', near)
            if s and s != style:
                style = s
                stats['style'] += 1
                changed = True

        if not changed:
            skipped += 1
            continue

        # 生成新文件名
        seg = [clean_seg(artist), clean_seg(title), clean_seg(lang), clean_seg(style)]
        new_fn = '-'.join(seg) + '.flac'
        if new_fn == fn:
            skipped += 1
            continue

        old_path = os.path.join(dp, fn)
        new_path = os.path.join(dp, new_fn)

        # 处理重名
        if os.path.exists(new_path) and new_path != old_path:
            bn = new_fn[:-5]
            i = 2
            while os.path.exists(os.path.join(dp, bn + f'({i}).flac')):
                i += 1
            new_fn = bn + f'({i}).flac'
            new_path = os.path.join(dp, new_fn)

        try:
            os.rename(old_path, new_path)
            renamed += 1
        except Exception as e:
            print(f'[FAIL] {fn}: {e}')
            failed += 1

    print(f'\n完成: 修复={renamed} 跳过={skipped} 失败={failed} 用时={time.time()-t0:.0f}s')
    print(f'修复明细: 歌名={stats["title"]} 歌手={stats["artist"]} 风格={stats["style"]} 网站={stats["site"]} 序号前缀={stats["prefix"]} 括号歌手={stats["paren"]}')

if __name__ == '__main__':
    main()
