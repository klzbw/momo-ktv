# -*- coding: utf-8 -*-
"""扫描当前all-flacs中的Trackxx文件，按专辑分组。"""
import os, re, json

out = r'\\192.168.3.80\music\all-flacs'
GENERIC_RE = re.compile(r'^(Track|音轨|track|TRACK|Unknown Title|未知标题|Untitled)\d*$', re.I)

albums = {}
for dp, dns, fns in os.walk(out):
    for fn in fns:
        if not fn.endswith('.flac'): continue
        parts = fn[:-5].split('-', 3)
        if len(parts) != 4: continue
        artist, title, lang, style = parts
        if GENERIC_RE.match(title):
            rel = os.path.relpath(dp, out)
            if rel not in albums:
                albums[rel] = {'count': 0, 'artist': artist, 'files': []}
            albums[rel]['count'] += 1
            albums[rel]['files'].append(fn)

print('含Trackxx的专辑:', len(albums), '个')
print('总Trackxx文件:', sum(a['count'] for a in albums.values()))
print()
# 按文件数排序
for rel, info in sorted(albums.items(), key=lambda x: -x[1]['count'])[:30]:
    print(f'  [{info["count"]}首] {rel}')
    print(f'    歌手: {info["artist"]}')

# 保存到文件
with open(r'C:\Users\Administrator\Desktop\ai-worker\current_track_albums.json', 'w', encoding='utf-8') as f:
    json.dump(albums, f, ensure_ascii=False, indent=2)
print('\n已保存到 current_track_albums.json')
