# -*- coding: utf-8 -*-
"""
phase1_rename.py —— 第一阶段：快速重命名（只改文件名，不更新metadata）
去掉序号，改为四段：歌手-歌名-语种-风格.flac
同时修正歌名/歌手/风格（从txt推断），但只改文件名，metadata后续更新。
"""
import os, re, sys, time

if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from flac_convert import (read_text_auto, clean_seg, artist_from_txt,
                          guess_style, fix_tracks_from_txt, parse_cue)

OUT_ROOT = r'\\192.168.3.80\music\all-flacs'
SRC_ROOT = r'\\192.168.3.80\music'

def parse_old_name(fname):
    base = fname[:-5] if fname.lower().endswith('.flac') else fname
    parts = base.split('-', 5)
    if len(parts) != 6:
        return None
    return parts

def build_new_name(artist, title, lang, style):
    seg = [clean_seg(artist), clean_seg(title), clean_seg(lang), clean_seg(style)]
    name = '-'.join(seg)
    if len(name.encode('utf-8')) > 200:
        over = len(name.encode('utf-8')) - 200
        seg[1] = seg[1][:max(1, len(seg[1]) - over // 2 - 1)]
        name = '-'.join(seg)
    return name + '.flac'

def get_src_info(src_dir, track_no):
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

def main():
    renamed = 0
    skipped = 0
    failed = 0
    t0 = time.time()
    title_fixed = artist_fixed = style_fixed = 0

    all_files = []
    for dp, dns, fns in os.walk(OUT_ROOT):
        for fn in fns:
            if fn.lower().endswith('.flac'):
                all_files.append((dp, fn))

    print(f'共发现 {len(all_files)} 个FLAC文件，开始快速重命名...')

    for idx, (dp, fn) in enumerate(all_files):
        if idx % 500 == 0 and idx > 0:
            print(f'  进度: {idx}/{len(all_files)} ({idx*100//len(all_files)}%) 已重命名={renamed} 失败={failed} 用时={time.time()-t0:.0f}s')

        parts = parse_old_name(fn)
        if not parts:
            if fn[:-5].count('-') == 3:
                skipped += 1
            continue

        no, old_artist, old_title, old_lang, old_style, old_album = parts
        track_no = int(no) if no.isdigit() else 0

        rel = os.path.relpath(dp, OUT_ROOT)
        src_dir = os.path.join(SRC_ROOT, rel)

        new_title = old_title
        new_artist = old_artist
        new_style = old_style

        # 歌名修正
        if re.match(r'^(Track|音轨|track|TRACK|Unknown Title|未知标题|Untitled)\d*$', old_title, re.I):
            t, a, s = get_src_info(src_dir, track_no)
            if t and t != old_title:
                new_title = t
                title_fixed += 1
            if a and a not in ('未知', 'Unknown Artist', '未知艺术家') and a != old_artist:
                new_artist = a
                artist_fixed += 1
            if s and s != old_style:
                new_style = s
                style_fixed += 1

        # 清理歌手名
        cleaned_artist = clean_seg(new_artist)
        if cleaned_artist != new_artist:
            new_artist = cleaned_artist
            artist_fixed += 1

        # 风格修正
        if new_style in ('未知', '发烧', 'Other', 'Unknown', '') or '论坛' in new_style or '收藏' in new_style:
            near = os.path.basename(dp) + ' ' + os.path.basename(os.path.dirname(dp))
            s = guess_style('', near)
            if s and s != new_style:
                new_style = s
                style_fixed += 1

        new_fn = build_new_name(new_artist, new_title, old_lang, new_style)
        if new_fn == fn:
            skipped += 1
            continue

        old_path = os.path.join(dp, fn)
        new_path = os.path.join(dp, new_fn)

        # 处理重名
        if os.path.exists(new_path) and new_path != old_path:
            base_new = new_fn[:-5]
            i = 2
            while os.path.exists(os.path.join(dp, base_new + f'({i}).flac')):
                i += 1
            new_fn = base_new + f'({i}).flac'
            new_path = os.path.join(dp, new_fn)

        try:
            os.rename(old_path, new_path)
            renamed += 1
        except Exception as e:
            print(f'[FAIL] {fn}: {e}')
            failed += 1

    print(f'\n第一阶段完成: 重命名={renamed} 跳过={skipped} 失败={failed} 用时={time.time()-t0:.0f}s')
    print(f'修正统计: 歌名={title_fixed} 歌手={artist_fixed} 风格={style_fixed}')

if __name__ == '__main__':
    main()
