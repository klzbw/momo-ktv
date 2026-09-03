# -*- coding: utf-8 -*-
"""
fix_unknown_artist.py —— 修复 all-flacs 中艺术家为"未知"的文件
从源目录的txt/目录名重新提取艺术家，重命名文件并更新metadata。
用法: python fix_unknown_artist.py [--dry]
"""
import os, re, sys, subprocess, argparse, time

if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from flac_convert import artist_from_txt, clean_seg, read_text_auto, FFMPEG

OUT_ROOT = r'\\192.168.3.80\music\all-flacs'
SRC_ROOT = r'\\192.168.3.80\music'

def parse_name(fname):
    base = fname[:-5] if fname.lower().endswith('.flac') else fname
    parts = base.split('-', 5)
    if len(parts) != 6:
        return None
    return parts

def build_name(no, artist, title, lang, style, album):
    seg = [clean_seg(no).zfill(2), clean_seg(artist), clean_seg(title),
           clean_seg(lang), clean_seg(style), clean_seg(album)]
    name = '-'.join(seg)
    if len(name.encode('utf-8')) > 200:
        over = len(name.encode('utf-8')) - 200
        seg[2] = seg[2][:max(1, len(seg[2]) - over // 3 - 1)]
        name = '-'.join(seg)
    return name + '.flac'

def fix_metadata(in_path, out_path, artist, title, album, genre, lang, track):
    cmd = [FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-i', in_path,
           '-map', '0:a', '-c:a', 'copy', '-f', 'flac',
           '-metadata', 'TITLE=' + title,
           '-metadata', 'ARTIST=' + artist,
           '-metadata', 'ALBUM=' + album,
           '-metadata', 'GENRE=' + genre,
           '-metadata', 'LANGUAGE=' + lang,
           '-metadata', 'TRACKNUMBER=' + track,
           out_path]
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        return False, p.stderr.decode('utf-8', 'replace')[:200]
    return True, ''

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry', action='store_true')
    ap.add_argument('--root', default=OUT_ROOT)
    args = ap.parse_args()

    fixed = 0
    skipped = 0
    failed = 0
    no_artist = 0
    t0 = time.time()

    for dp, dns, fns in os.walk(args.root):
        for fn in fns:
            if not fn.lower().endswith('.flac'):
                continue
            parts = parse_name(fn)
            if not parts:
                continue
            no, artist, title, lang, style, album = parts
            if artist != '未知':
                skipped += 1
                continue
            # 找对应的源目录
            rel = os.path.relpath(dp, args.root)
            src_dir = os.path.join(SRC_ROOT, rel)
            if not os.path.isdir(src_dir):
                skipped += 1
                continue
            new_artist = artist_from_txt(src_dir)
            if not new_artist or new_artist == '未知':
                no_artist += 1
                continue
            new_fn = build_name(no, new_artist, title, lang, style, album)
            if new_fn == fn:
                skipped += 1
                continue
            old_path = os.path.join(dp, fn)
            new_path = os.path.join(dp, new_fn)
            print(f'[修复] {fn}')
            print(f'    艺术家: 未知 -> {new_artist}')
            print(f'    源目录: {src_dir}')
            if args.dry:
                fixed += 1
                continue
            tmp_path = new_path + '.tmp'
            ok, err = fix_metadata(old_path, tmp_path, new_artist, title, album, style, lang, no)
            if not ok:
                print(f'    [FAIL] {err}')
                failed += 1
                continue
            try:
                os.replace(tmp_path, new_path)
                if os.path.exists(old_path) and old_path != new_path:
                    os.remove(old_path)
                fixed += 1
            except Exception as e:
                print(f'    [FAIL] 替换失败: {e}')
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
                failed += 1

    print(f'\n完成: 修复={fixed} 无需修复={skipped} 无艺术家信息={no_artist} 失败={failed} 用时={time.time()-t0:.0f}s')

if __name__ == '__main__':
    main()
