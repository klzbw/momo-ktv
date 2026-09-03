# -*- coding: utf-8 -*-
"""修复喜多郎敦煌、窦唯八段锦/口音的音轨序号歌名。"""
import os, re

out = r'\\192.168.3.80\music\all-flacs'

ALBUM_MAP = [
    (r'喜多郎.*敦煌', [
        "风神", "海市蜃楼", "巡礼之旅", "砂之神", "敦煌的思念",
        "飞翔", "曼陀罗", "道", "巡礼之旅II"
    ], "喜多郎"),
    (r'窦唯.*八段锦', [
        "安早光阳", "半苑草", "十一庆1995", "六一儿1995", "五一游1995",
        "八一队正步1995", "照灯语录", "念", "阳光早安"
    ], "窦唯"),
    (r'窦唯.*口音', [
        "师已", "口音1", "幻域", "尧帝遥桥图", "口音2",
        "杜十姑", "殃事", "口音3"
    ], "窦唯"),
]

fixed = 0
for dp, dns, fns in os.walk(out):
    rel = os.path.relpath(dp, out)
    for pattern, tracks, artist_name in ALBUM_MAP:
        if not re.search(pattern, rel):
            continue
        for fn in fns:
            if not fn.endswith('.flac'): continue
            name = fn[:-5]
            parts = name.split('-', 3)
            if len(parts) != 4: continue
            artist, title, lang, style = parts
            tm = re.match(r'^音轨序号(\d+)', title)
            if not tm:
                continue
            idx = int(tm.group(1)) - 1
            if idx >= len(tracks):
                continue
            new_title = tracks[idx]
            new_artist = artist_name
            new_fn = f'{new_artist}-{new_title}-{lang}-{style}.flac'
            old_path = os.path.join(dp, fn)
            new_path = os.path.join(dp, new_fn)
            try:
                if os.path.exists(new_path):
                    os.remove(old_path)
                else:
                    os.rename(old_path, new_path)
                fixed += 1
            except Exception as e:
                print(f'错误: {fn}: {e}')

print(f'修复: {fixed} 个')
