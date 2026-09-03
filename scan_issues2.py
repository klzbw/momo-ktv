# -*- coding: utf-8 -*-
"""统计音轨序号、未知歌手、风格污染等问题。"""
import os, re
out = r'\\192.168.3.80\music\all-flacs'

yinxu = {}  # 音轨序号
unknown_artist = {}  # 未知歌手
bad_style = {}  # 风格污染
total = 0

for dp, dns, fns in os.walk(out):
    for fn in fns:
        if not fn.endswith('.flac'): continue
        total += 1
        name = fn[:-5]
        parts = name.split('-', 3)
        if len(parts) != 4: continue
        artist, title, lang, style = parts
        rel = os.path.relpath(dp, out)
        
        # 音轨序号
        if re.match(r'^音轨序号\s*\d+', title):
            yinxu[rel] = yinxu.get(rel, 0) + 1
        
        # 未知歌手
        if artist in ('未知', '未知艺术家', 'Unknown Artist', 'unknown artist', 'Unknown'):
            unknown_artist[rel] = unknown_artist.get(rel, 0) + 1
        
        # 风格污染（论坛名、宣传语、英文等）
        bad_style_patterns = [r'论坛', r'收藏', r'http', r'www\.', r'^Pop$', r'^Classical$', r'^National Folk$', r'Pop－', r'深深D爱', r'我要去听', r'精品音乐']
        if any(re.search(p, style, re.I) for p in bad_style_patterns):
            bad_style.setdefault(style, []).append((rel, fn))

print(f'总文件: {total}')
print(f'\n=== 音轨序号歌名: {sum(yinxu.values())} 个, {len(yinxu)} 个专辑 ===')
for d, c in sorted(yinxu.items(), key=lambda x: -x[1]):
    print(f'  [{c}] {d}')

print(f'\n=== 未知歌手: {sum(unknown_artist.values())} 个, {len(unknown_artist)} 个专辑 ===')
for d, c in sorted(unknown_artist.items(), key=lambda x: -x[1])[:20]:
    print(f'  [{c}] {d}')

print(f'\n=== 风格污染: {sum(len(v) for v in bad_style.values())} 个 ===')
for s, items in sorted(bad_style.items(), key=lambda x: -len(x[1]))[:15]:
    print(f'  [{len(items)}] 风格="{s}"')
    for rel, fn in items[:2]:
        print(f'      {fn}')
