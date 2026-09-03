# -*- coding: utf-8 -*-
"""批量修复风格污染和未知歌手。"""
import os, re

out = r'\\192.168.3.80\music\all-flacs'

STYLE_MAP = {
    'Pop': '流行', 'POP': '流行', 'pop': '流行',
    'Classical': '古典', 'classical': '古典',
    'National Folk': '民族', 'national folk': '民族',
    'Pop－Folk': '民谣', 'Pop-Folk': '民谣',
    '炫音论坛': '流行', '倦鸟馀花论坛': '流行',
    '精品音乐尽在枫情音乐论坛': '流行',
    '深深D爱': '流行', '冰山一角收藏': '流行',
    '我要去听论坛': '流行',
}

UNKNOWN_ARTISTS = {'未知', '未知艺术家', 'Unknown Artist', 'unknown artist', 'Unknown', 'unknown'}

style_fixed = 0
artist_fixed = 0
errors = 0

for dp, dns, fns in os.walk(out):
    for fn in fns:
        if not fn.endswith('.flac'): continue
        old_path = os.path.join(dp, fn)
        name = fn[:-5]
        parts = name.split('-', 3)
        if len(parts) != 4: continue
        artist, title, lang, style = parts
        
        new_artist = artist
        new_style = style
        changed = False
        
        # 修复风格
        if style in STYLE_MAP:
            new_style = STYLE_MAP[style]
            changed = True
        elif re.search(r'(论坛|收藏|http|www\.)', style, re.I):
            new_style = '流行'
            changed = True
        
        # 修复未知歌手
        if artist in UNKNOWN_ARTISTS:
            new_artist = '群星'
            changed = True
        
        if not changed:
            continue
        
        new_fn = f'{new_artist}-{title}-{lang}-{new_style}.flac'
        new_path = os.path.join(dp, new_fn)
        if new_path == old_path:
            continue
        
        try:
            if os.path.exists(new_path):
                os.remove(old_path)
            else:
                os.rename(old_path, new_path)
            if new_style != style:
                style_fixed += 1
            if new_artist != artist:
                artist_fixed += 1
        except Exception as e:
            errors += 1

print(f'风格修复: {style_fixed} 个')
print(f'未知歌手修复: {artist_fixed} 个')
print(f'错误: {errors} 个')
