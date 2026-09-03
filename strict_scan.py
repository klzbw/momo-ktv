# -*- coding: utf-8 -*-
"""最严格的命名合规扫描，覆盖所有不正规模式。"""
import os, re, sys

out = r'\\192.168.3.80\music\all-flacs'

# 各种不正规模式
PATTERNS = {
    '数字前缀(01./01-)': re.compile(r'^\d{1,3}[\.\s\-_]'),
    'Track开头': re.compile(r'^(Track|track|TRACK|Track\s*\d+)', re.I),
    '音轨开头': re.compile(r'^音轨\s*\d+'),
    '歌名含网站': re.compile(r'(music\.163|qq\.com|xiami|kugou|kuwo|51qt|论坛|http|www\.)', re.I),
    '歌手含论坛/网站': re.compile(r'(论坛|http|www\.|music\.163|qq\.com)', re.I),
    '歌手是专辑名/宣传语': re.compile(r'^(群星·|发烧|纯音|网络|DTS|DSD|HQCD|SQCD|音乐殿堂|民族之响|响·发烧)', re.I),
    '歌手为空或未知': re.compile(r'^(未知艺术家|未知|Unknown|unknown|群星$)'),  # 群星是合法的，但标记出来
    '歌名含序号括号': re.compile(r'[（(]\s*\d{1,2}\s*[）)]'),
    '文件名含非法字符': re.compile(r'[\\/:*?"<>|]'),
    '歌名是纯数字': re.compile(r'^\d+$'),
    '歌名过短(<2字)': None,  # 特殊处理
}

results = {k: [] for k in PATTERNS}
results['格式非四段'] = []
results['字段为空'] = []
results['重复文件名'] = []

total = 0
name_set = {}

for dp, dns, fns in os.walk(out):
    for fn in fns:
        if not fn.endswith('.flac'): continue
        total += 1
        name = fn[:-5]
        rel = os.path.relpath(dp, out)
        
        # 检查格式
        parts = name.split('-', 3)
        if len(parts) != 4:
            results['格式非四段'].append((rel, fn))
            continue
        artist, title, lang, style = parts
        
        # 字段为空
        if not artist.strip() or not title.strip() or not lang.strip() or not style.strip():
            results['字段为空'].append((rel, fn))
        
        # 检查各模式
        for pname, pattern in PATTERNS.items():
            if pattern is None:
                if len(title.strip()) < 2:
                    results[pname].append((rel, fn))
            elif pname == '歌手含论坛/网站' or pname == '歌手是专辑名/宣传语' or pname == '歌手为空或未知':
                if pattern.search(artist):
                    results[pname].append((rel, fn))
            else:
                if pattern.search(title):
                    results[pname].append((rel, fn))
        
        # 文件名含非法字符
        if PATTERNS['文件名含非法字符'].search(fn):
            results['文件名含非法字符'].append((rel, fn))
        
        # 重复文件名（同名不同目录不算，同目录才算）
        key = (rel, name)
        if key in name_set:
            results['重复文件名'].append((rel, fn))
        else:
            name_set[key] = True

print(f'总文件数: {total}')
print(f'{"="*60}')
for pname, items in results.items():
    if items:
        print(f'\n【{pname}】{len(items)} 个')
        # 按目录分组显示
        dirs = {}
        for rel, fn in items:
            dirs.setdefault(rel, []).append(fn)
        for d, fns in sorted(dirs.items(), key=lambda x: -len(x[1])):
            print(f'  [{len(fns)}] {d}')
            for fn in fns[:3]:
                print(f'      {fn}')
            if len(fns) > 3:
                print(f'      ... 共{len(fns)}个')
    else:
        print(f'【{pname}】0 个 ✓')
