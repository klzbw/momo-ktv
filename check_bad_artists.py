# -*- coding: utf-8 -*-
import os, re
from collections import Counter

out = r'\\192.168.3.80\music\all-flacs'
SITE_ARTIST_RE = re.compile(r'(论坛|网|音乐论坛|发烧|HIFI|hifi|JPHiFi|炫音|枫情|无损|SQCD|XRCD|K2HD|LPCD|HQCD|DSD|DTS)', re.I)

artists = Counter()
files_by_artist = {}
for dp, dns, fns in os.walk(out):
    for fn in fns:
        if not fn.endswith('.flac'): continue
        parts = fn[:-5].split('-', 3)
        if len(parts) != 4: continue
        artist = parts[0]
        if SITE_ARTIST_RE.search(artist):
            artists[artist] += 1
            if artist not in files_by_artist:
                files_by_artist[artist] = []
            files_by_artist[artist].append((dp, fn))

print('异常歌手名统计:')
for artist, count in artists.most_common():
    print(f'  [{count}] {artist}')
    # 显示前3个文件的歌名
    for dp, fn in files_by_artist[artist][:3]:
        parts = fn[:-5].split('-', 3)
        print(f'    歌名: {parts[1]}')
