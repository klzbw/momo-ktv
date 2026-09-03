# -*- coding: utf-8 -*-
"""
fix_all_names.py —— 全面修复all-flacs命名（优化版）
- 去掉序号，改为四段：歌手-歌名-语种-风格.flac
- 从txt修正Trackxx/音轨xx歌名
- 清理歌手名中的收藏标记/网站信息
- 用增强的guess_style修正风格
- 仅重命名: os.rename（快）
- 字段变化时: ffmpeg copy更新metadata
用法: python fix_all_names.py [--dry]
"""
import os, re, sys, subprocess, argparse, time

if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from flac_convert import (read_text_auto, clean_seg, artist_from_txt,
                          guess_style, guess_lang, fix_tracks_from_txt,
                          parse_cue, FFMPEG)

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

def fix_metadata(in_path, out_path, artist, title, album, genre, lang, track, orig_name):
    cmd = [FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-i', in_path,
           '-map', '0:a', '-c:a', 'copy', '-f', 'flac',
           '-metadata', 'TITLE=' + title,
           '-metadata', 'ARTIST=' + artist,
           '-metadata', 'ALBUM=' + album,
           '-metadata', 'GENRE=' + genre,
           '-metadata', 'LANGUAGE=' + lang,
           '-metadata', 'TRACKNUMBER=' + track,
           '-metadata', 'COMMENT=Original: ' + orig_name,
           out_path]
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        return False, p.stderr.decode('utf-8', 'replace')[:200]
    return True, ''

def get_src_info(src_dir, track_no):
    title = artist = style = None
    album_title = os.path.basename(src_dir)
    if not os.path.isdir(src_dir):
        return title, artist, style, album_title
    cues = [f for f in os.listdir(src_dir) if f.lower().endswith('.cue')]
    if cues:
        try:
            album, tracks = parse_cue(read_text_auto(os.path.join(src_dir, cues[0])))
            album_title = album.get('title', '') or album_title
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
    return title, artist, style, album_title

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry', action='store_true')
    ap.add_argument('--root', default=OUT_ROOT)
    args = ap.parse_args()

    renamed = 0
    metadata_updated = 0
    skipped = 0
    failed = 0
    t0 = time.time()
    title_fixed = artist_fixed = style_fixed = 0

    # 收集所有文件
    all_files = []
    for dp, dns, fns in os.walk(args.root):
        for fn in fns:
            if fn.lower().endswith('.flac'):
                all_files.append((dp, fn))

    print(f'共发现 {len(all_files)} 个FLAC文件')

    for idx, (dp, fn) in enumerate(all_files):
        if idx % 500 == 0 and idx > 0:
            print(f'  进度: {idx}/{len(all_files)} ({idx*100//len(all_files)}%) 已重命名={renamed} 元数据更新={metadata_updated} 失败={failed} 用时={time.time()-t0:.0f}s')

        parts = parse_old_name(fn)
        if not parts:
            base = fn[:-5]
            if base.count('-') == 3:
                skipped += 1
            continue

        no, old_artist, old_title, old_lang, old_style, old_album = parts
        track_no = int(no) if no.isdigit() else 0

        rel = os.path.relpath(dp, args.root)
        src_dir = os.path.join(SRC_ROOT, rel)

        new_title = old_title
        new_artist = old_artist
        new_style = old_style
        new_album = old_album
        need_metadata = False

        # 歌名修正
        if re.match(r'^(Track|音轨|track|TRACK|Unknown Title|未知标题|Untitled)\d*$', old_title, re.I):
            if os.path.isdir(src_dir):
                t, a, s, al = get_src_info(src_dir, track_no)
                if t and t != old_title:
                    new_title = t
                    title_fixed += 1
                    need_metadata = True
                if a and a not in ('未知', 'Unknown Artist', '未知艺术家') and a != old_artist:
                    new_artist = a
                    artist_fixed += 1
                    need_metadata = True
                if s and s != old_style:
                    new_style = s
                    style_fixed += 1
                    need_metadata = True
                if al and al != old_album:
                    new_album = al
                    need_metadata = True

        # 清理歌手名
        cleaned_artist = clean_seg(new_artist)
        if cleaned_artist != new_artist:
            new_artist = cleaned_artist
            artist_fixed += 1
            need_metadata = True

        # 风格修正
        if new_style in ('未知', '发烧', 'Other', 'Unknown', '') or '论坛' in new_style or '收藏' in new_style:
            near = os.path.basename(dp) + ' ' + os.path.basename(os.path.dirname(dp))
            s = guess_style('', near)
            if s and s != new_style:
                new_style = s
                style_fixed += 1
                need_metadata = True

        # 生成新文件名
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

        if args.dry:
            renamed += 1
            if need_metadata:
                metadata_updated += 1
            continue

        try:
            if need_metadata:
                # 需要更新metadata，用ffmpeg
                tmp_path = new_path + '.tmp'
                ok, err = fix_metadata(old_path, tmp_path, new_artist, new_title,
                                       new_album, new_style, old_lang, no, fn)
                if not ok:
                    print(f'[FAIL metadata] {fn}: {err}')
                    failed += 1
                    continue
                os.replace(tmp_path, new_path)
                if os.path.exists(old_path) and old_path != new_path:
                    os.remove(old_path)
                metadata_updated += 1
            else:
                # 只需重命名
                os.rename(old_path, new_path)
            renamed += 1
        except Exception as e:
            print(f'[FAIL] {fn}: {e}')
            failed += 1

    print(f'\n完成: 重命名={renamed} (其中元数据更新={metadata_updated}) 跳过={skipped} 失败={failed} 用时={time.time()-t0:.0f}s')
    print(f'修正统计: 歌名={title_fixed} 歌手={artist_fixed} 风格={style_fixed}')

if __name__ == '__main__':
    main()
