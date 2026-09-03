# -*- coding: utf-8 -*-
import os, re
from collections import defaultdict

out = r'\\192.168.3.80\music\all-flacs'
SITE_ARTIST_RE = re.compile(r'(论坛|网|音乐论坛|发烧|HIFI|hifi|JPHiFi|炫音|枫情|无损|SQCD|XRCD|K2HD|LPCD|HQCD|DSD|DTS)', re.I)

by_artist_dir = defaultdict(lambda: defaultdict(list))
for dp, dns, fns in os.walk(out):
    for fn in fns:
        if not fn.endswith('.flac'): continue
        parts = fn[:-5].split('-', 3)
        if len(parts) != 4: continue
        artist = parts[0]
        if SITE_ARTIST_RE.search(artist):
            rel = os.path.relpath(dp, out)
            by_artist_dir[artist][rel].append(fn)

for artist, dirs in sorted(by_artist_dir.items(), key=lambda x: -sum(len(v) for v in x[1].values())):
    total = sum(len(v) for v in dirs.values())
    print(f'\n=== [{total}] {artist} ===')
    for rel, files in sorted(dirs.items(), key=lambda x: -len(x[1])):
        print(f'  目录: {rel} ({len(files)}首)')
        print(f'  示例: {files[0]}')
        if len(files) > 1:
            print(f'        {files[1]}')
