# -*- coding: utf-8 -*-
import os, re
out = r'\\192.168.3.80\music\all-flacs'
GENERIC_RE = re.compile(r'^(Track|音轨|track|TRACK|Unknown Title|未知标题|Untitled)\d*$', re.I)

albums = {}
total = 0
for dp, dns, fns in os.walk(out):
    for fn in fns:
        if not fn.endswith('.flac'): continue
        parts = fn[:-5].split('-', 3)
        if len(parts) != 4: continue
        artist, title, lang, style = parts
        if GENERIC_RE.match(title):
            total += 1
            rel = os.path.relpath(dp, out)
            if rel not in albums:
                albums[rel] = {'count': 0, 'artist': artist, 'sample': title}
            albums[rel]['count'] += 1

print(f'通用序号歌名总数: {total}')
print(f'涉及专辑: {len(albums)} 个')
print()
for rel, info in sorted(albums.items(), key=lambda x: -x[1]['count']):
    print(f'  [{info["count"]}首] {rel}')
    print(f'    歌手={info["artist"]}, 示例={info["sample"]}')
