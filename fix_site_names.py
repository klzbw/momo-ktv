# -*- coding: utf-8 -*-
"""
fix_site_names.py —— 批量清理 all-flacs 中文件名和 metadata 里的网站信息
用法: python fix_site_names.py [--dry] [--only 路径关键字]
"""
import os, re, sys, subprocess, argparse, time

if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

FFMPEG = r'C:\ffmpeg\bin\ffmpeg.exe'
OUT_ROOT = r'\\192.168.3.80\music\all-flacs'

SITE_RE = re.compile(
    r'[【\[\(][^】\]\)]*(?:www\.|https?://|[\w-]+\.(?:com|cn|net|org|cc|tv|io|me|co|info|biz|top|xyz|vip|club|site|online|store|tech|app|dev|cloud|zone|fm|radio))[^】\]\)]*[】\]\)]',
    re.I)
DOMAIN_RE = re.compile(
    r'(?:www\.)?[a-zA-Z0-9][a-zA-Z0-9-]*\.(?:com|cn|net|org|cc|tv|io|me|co|info|biz|top|xyz|vip|club|site|online|store|tech|app|dev|cloud|zone|fm|radio)(?:\.(?:com|cn|net|org))?',
    re.I)
BAD_FN = re.compile(r'[\\/:*?"<>|\r\n\t]')

def clean(s):
    x = BAD_FN.sub(' ', s or '').replace('-', '－')
    x = SITE_RE.sub(' ', x)
    x = DOMAIN_RE.sub(' ', x)
    x = re.sub(r'\s+', ' ', x).strip(' -－_·')
    return x or '未知'

def parse_name(fname):
    """解析六段文件名: 序号-人名-歌名-语言-风格-专辑.flac"""
    base = fname[:-5] if fname.lower().endswith('.flac') else fname
    parts = base.split('-', 5)
    if len(parts) != 6:
        return None
    return parts

def build_name(no, artist, title, lang, style, album):
    seg = [clean(no).zfill(2), clean(artist), clean(title),
           clean(lang), clean(style), clean(album)]
    name = '-'.join(seg)
    if len(name.encode('utf-8')) > 200:
        over = len(name.encode('utf-8')) - 200
        seg[2] = seg[2][:max(1, len(seg[2]) - over // 3 - 1)]
        name = '-'.join(seg)
    return name + '.flac'

def has_site(s):
    return bool(SITE_RE.search(s or '') or DOMAIN_RE.search(s or ''))

def fix_metadata(in_path, out_path, artist, title, album, genre, lang, track):
    """用ffmpeg重新写入metadata，复制音频流。"""
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
    ap.add_argument('--only', default='')
    ap.add_argument('--root', default=OUT_ROOT)
    args = ap.parse_args()

    renamed = 0
    skipped = 0
    failed = 0
    t0 = time.time()

    for dp, dns, fns in os.walk(args.root):
        for fn in fns:
            if not fn.lower().endswith('.flac'):
                continue
            if args.only and args.only not in os.path.join(dp, fn):
                continue
            parts = parse_name(fn)
            if not parts:
                continue
            no, artist, title, lang, style, album = parts
            # 检查是否有网站信息
            if not any(has_site(p) for p in parts):
                skipped += 1
                continue
            new_fn = build_name(no, artist, title, lang, style, album)
            if new_fn == fn:
                skipped += 1
                continue
            old_path = os.path.join(dp, fn)
            new_path = os.path.join(dp, new_fn)
            print(f'[重命名] {fn}')
            print(f'      -> {new_fn}')
            if args.dry:
                renamed += 1
                continue
            # 先写入临时文件（修复metadata），再替换
            tmp_path = new_path + '.tmp'
            ok, err = fix_metadata(old_path, tmp_path,
                                   clean(artist), clean(title), clean(album),
                                   clean(style), clean(lang), clean(no))
            if not ok:
                print(f'  [FAIL] metadata修复失败: {err}')
                failed += 1
                continue
            try:
                os.replace(tmp_path, new_path)
                if os.path.exists(old_path) and old_path != new_path:
                    os.remove(old_path)
                renamed += 1
            except Exception as e:
                print(f'  [FAIL] 替换文件失败: {e}')
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
                failed += 1

    print(f'\n完成: 重命名={renamed} 跳过={skipped} 失败={failed} 用时={time.time()-t0:.0f}s')

if __name__ == '__main__':
    main()
