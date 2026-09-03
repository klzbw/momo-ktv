# -*- coding: utf-8 -*-
"""修复最新流行发烧金曲DSD的13首，用正确歌手名。"""
import os, re

out = r'\\192.168.3.80\music\all-flacs'
d = os.path.join(out, r'03 群星【无损音乐】\最新流行发烧金曲 DSD\CDImage')

tracks = [
    ("青花瓷", "沉千琦"), ("有没有人告诉你", "林子路"), ("香烟爱上火柴", "云儿非"),
    ("自由飞翔", "林子路"), ("只欠秋天", "沉千琦"), ("今生最爱", "云儿非"),
    ("左眼皮跳跳", "沉千琦"), ("坐上火车去拉萨", "林子路"), ("等一分钟", "云儿非"),
    ("有一种爱叫做放手", "林子路"), ("别说你还爱着我", "云儿非"),
    ("对不起我的最爱", "沉千琦"), ("不要在寂寞的时候说爱我", "林子路"),
]

fixed = 0
for fn in os.listdir(d):
    if not fn.endswith('.flac'): continue
    name = fn[:-5]
    parts = name.split('-', 3)
    if len(parts) != 4: continue
    artist, title, lang, style = parts
    
    # 匹配Trackxx
    tm = re.match(r'^Track(\d+)', title)
    if tm:
        idx = int(tm.group(1)) - 1
        if idx < len(tracks):
            new_title, new_artist = tracks[idx]
            new_fn = f'{new_artist}-{new_title}-{lang}-{style}.flac'
            old = os.path.join(d, fn)
            new = os.path.join(d, new_fn)
            if os.path.exists(new):
                os.remove(old)
            else:
                os.rename(old, new)
            fixed += 1
            print(f'  Track{tm.group(1)} → {new_artist}-{new_title}')
    else:
        # 已命名的，检查歌手是否正确
        for i, (t, a) in enumerate(tracks):
            if t == title and artist != a:
                new_fn = f'{a}-{title}-{lang}-{style}.flac'
                old = os.path.join(d, fn)
                new = os.path.join(d, new_fn)
                if not os.path.exists(new):
                    os.rename(old, new)
                    fixed += 1
                    print(f'  {artist} → {a}: {title}')
                break

print(f'\n修复: {fixed} 个')
