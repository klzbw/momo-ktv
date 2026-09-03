# -*- coding: utf-8 -*-
"""
fix_track_names.py —— 从源目录txt读取曲目列表，修正Trackxx歌名和未知专辑名
- 读取同级/上级目录txt，解析曲目列表
- 替换Track01等为实际歌名
- 修正"未知标题"专辑名（从目录名/txt推断）
- 移动到规范命名的目录
- metadata中保留原始信息（ORIGINAL_TITLE/COMMENT）
用法: python fix_track_names.py [--dry]
"""
import os, re, sys, subprocess, argparse, time, shutil

if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from flac_convert import read_text_auto, clean_seg, artist_from_txt, FFMPEG

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

def parse_track_list(text):
    """从txt文本解析曲目列表，返回 {序号: 歌名}。"""
    tracks = {}
    for line in text.splitlines():
        line = line.strip()
        # 匹配 "01 歌名" / "01.歌名" / "1、歌名" / "01．歌名" 等
        m = re.match(r'^(\d{1,3})[\s\.\、\．\-:：]+(.+)$', line)
        if m:
            no = int(m.group(1))
            title = m.group(2).strip()
            # 清理歌名中的多余信息
            title = re.sub(r'\s*[\(（][^\)）]*[\)）]\s*$', '', title)
            title = re.sub(r'\s{2,}', ' ', title).strip(' -_·')
            if title and len(title) <= 100:
                tracks[no] = title
    return tracks

def find_txt(src_dir, max_up=2):
    """在当前目录及上级目录找txt文件。"""
    cur = src_dir
    for level in range(max_up + 1):
        try:
            for f in os.listdir(cur):
                if f.lower().endswith('.txt'):
                    yield os.path.join(cur, f)
        except Exception:
            pass
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent

def infer_album_from_dir(src_dir):
    """从目录名推断专辑名。"""
    base = os.path.basename(src_dir)
    # 去掉常见后缀
    base = re.sub(r'\[(WAV|APE|FLAC|DTS|DSD|HQCD|K2HD|XRCD|LP|黑胶)[^\]]*\]', '', base, flags=re.I)
    base = re.sub(r'[（(][^）)]*(WAV|APE|FLAC|DTS|DSD|整轨|分轨|无损)[^）)]*[）)]', '', base, flags=re.I)
    base = base.strip(' -_·')
    # 如果是CDA/CDB等子目录，用上级目录名
    if re.match(r'^(CD[A-Z]|CD\d|DISC\d|DISK\d)$', base, re.I):
        parent = os.path.basename(os.path.dirname(src_dir))
        parent = re.sub(r'\[(WAV|APE|FLAC|DTS|DSD|HQCD)[^\]]*\]', '', parent, flags=re.I)
        return parent.strip(' -_·') + ' ' + base
    return base

def fix_metadata(in_path, out_path, artist, title, album, genre, lang, track, orig_title):
    """重写metadata，保留原始歌名在COMMENT中。"""
    cmd = [FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-i', in_path,
           '-map', '0:a', '-c:a', 'copy', '-f', 'flac',
           '-metadata', 'TITLE=' + title,
           '-metadata', 'ARTIST=' + artist,
           '-metadata', 'ALBUM=' + album,
           '-metadata', 'GENRE=' + genre,
           '-metadata', 'LANGUAGE=' + lang,
           '-metadata', 'TRACKNUMBER=' + track,
           '-metadata', 'COMMENT=Original title: ' + orig_title,
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
    no_txt = 0
    t0 = time.time()

    for dp, dns, fns in os.walk(args.root):
        for fn in fns:
            if not fn.lower().endswith('.flac'):
                continue
            parts = parse_name(fn)
            if not parts:
                continue
            no, artist, title, lang, style, album = parts
            # 只处理歌名为Trackxx/音轨xx或专辑名为未知标题的
            is_track = bool(re.match(r'^(Track|音轨)\d+$', title, re.I))
            is_unknown_album = (album == '未知标题')
            if not is_track and not is_unknown_album:
                skipped += 1
                continue
            # 找源目录
            rel = os.path.relpath(dp, args.root)
            src_dir = os.path.join(SRC_ROOT, rel)
            if not os.path.isdir(src_dir):
                skipped += 1
                continue
            # 读取txt解析曲目列表
            track_map = {}
            txt_found = False
            for txt_path in find_txt(src_dir):
                txt_found = True
                try:
                    t = read_text_auto(txt_path)
                    tm = parse_track_list(t)
                    if len(tm) > len(track_map):
                        track_map = tm
                except Exception:
                    pass
            if not txt_found:
                no_txt += 1
                continue
            # 获取新歌名
            track_no = int(no) if no.isdigit() else 0
            new_title = track_map.get(track_no, title)
            # 获取新专辑名
            new_album = album
            if is_unknown_album:
                new_album = infer_album_from_dir(src_dir)
            # 如果歌名和专辑名都没变，跳过
            if new_title == title and new_album == album:
                skipped += 1
                continue
            # 从源目录重新获取艺术家
            new_artist = artist
            if artist == '未知':
                a = artist_from_txt(src_dir)
                if a:
                    new_artist = a
            new_fn = build_name(no, new_artist, new_title, lang, style, new_album)
            if new_fn == fn:
                skipped += 1
                continue
            old_path = os.path.join(dp, fn)
            # 新目录：如果专辑名变了，移动到新目录
            if new_album != album:
                new_dp = os.path.join(os.path.dirname(dp), new_album)
            else:
                new_dp = dp
            new_path = os.path.join(new_dp, new_fn)
            print(f'[修正] {fn}')
            if new_title != title:
                print(f'    歌名: {title} -> {new_title}')
            if new_album != album:
                print(f'    专辑: {album} -> {new_album}')
            if new_artist != artist:
                print(f'    艺术家: {artist} -> {new_artist}')
            if args.dry:
                fixed += 1
                continue
            os.makedirs(new_dp, exist_ok=True)
            tmp_path = new_path + '.tmp'
            ok, err = fix_metadata(old_path, tmp_path, new_artist, new_title,
                                   new_album, style, lang, no, title)
            if not ok:
                print(f'    [FAIL] {err}')
                failed += 1
                continue
            try:
                os.replace(tmp_path, new_path)
                if os.path.exists(old_path) and old_path != new_path:
                    os.remove(old_path)
                fixed += 1
                # 如果旧目录空了，删除
                try:
                    if not os.listdir(dp):
                        os.rmdir(dp)
                except Exception:
                    pass
            except Exception as e:
                print(f'    [FAIL] 替换失败: {e}')
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
                failed += 1

    print(f'\n完成: 修正={fixed} 跳过={skipped} 无txt={no_txt} 失败={failed} 用时={time.time()-t0:.0f}s')

if __name__ == '__main__':
    main()
