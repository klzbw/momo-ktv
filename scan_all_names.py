# -*- coding: utf-8 -*-
"""全面扫描all-flacs命名问题。"""
import os, re

out = r'\\192.168.3.80\music\all-flacs'

# 序号前缀：01. 01- 01、 01  1. 1- 等
NUM_PREFIX_RE = re.compile(r'^(\d{1,3})[\.\-、\s:：]+')
# 通用歌名
GENERIC_RE = re.compile(r'^(Track|音轨|track|TRACK|Unknown Title|未知标题|Untitled)\d*$', re.I)
# 网站/论坛名
SITE_ARTIST_RE = re.compile(r'(论坛|网|音乐论坛|发烧|HIFI|hifi|JPHiFi|炫音|枫情|无损)', re.I)
# 歌名中的网站信息
SITE_IN_TITLE_RE = re.compile(r'(https?://|www\.|\.com|\.net|论坛|网|JPHiFi|炫音|枫情|无损音乐|发烧音乐)', re.I)

issues = {
    'num_prefix': [],      # 歌名序号前缀
    'generic': [],         # 通用歌名
    'site_artist': [],     # 歌手是网站/论坛名
    'site_in_title': [],   # 歌名含网站信息
    'bad_format': [],      # 格式不对（不是四段）
    'empty_field': [],     # 字段为空
}

total = 0
for dp, dns, fns in os.walk(out):
    for fn in fns:
        if not fn.endswith('.flac'): continue
        total += 1
        name = fn[:-5]
        parts = name.split('-', 3)
        
        if len(parts) != 4:
            issues['bad_format'].append((dp, fn))
            continue
        
        artist, title, lang, style = parts
        
        # 空字段
        if not artist or not title or not lang or not style:
            issues['empty_field'].append((dp, fn))
            continue
        
        # 序号前缀
        if NUM_PREFIX_RE.match(title):
            issues['num_prefix'].append((dp, fn, title))
        
        # 通用歌名
        if GENERIC_RE.match(title):
            issues['generic'].append((dp, fn))
        
        # 歌手是网站/论坛名
        if SITE_ARTIST_RE.search(artist) and artist not in ('未知艺术家', '群星', '未知'):
            issues['site_artist'].append((dp, fn, artist))
        
        # 歌名含网站信息
        if SITE_IN_TITLE_RE.search(title):
            issues['site_in_title'].append((dp, fn, title))

print(f'总文件数: {total}')
print()
for key, desc in [
    ('num_prefix', '歌名序号前缀'),
    ('generic', '通用歌名(Track/音轨)'),
    ('site_artist', '歌手是网站/论坛名'),
    ('site_in_title', '歌名含网站信息'),
    ('bad_format', '格式不是四段'),
    ('empty_field', '字段为空'),
]:
    lst = issues[key]
    print(f'{desc}: {len(lst)} 个')
    if lst and len(lst) <= 10:
        for item in lst:
            print(f'  {item[1]}')
    elif lst:
        for item in lst[:5]:
            print(f'  {item[1]}')
        print(f'  ... 共{len(lst)}个')

# 保存详细列表
import json
with open(r'C:\Users\Administrator\Desktop\ai-worker\naming_issues.json', 'w', encoding='utf-8') as f:
    json.dump({k: [(dp, fn) + (extra if len(item) > 2 else ()) for item in v for dp, fn, *extra in [item]] for k, v in issues.items()}, f, ensure_ascii=False, indent=2)
print('\n详细列表已保存到 naming_issues.json')
