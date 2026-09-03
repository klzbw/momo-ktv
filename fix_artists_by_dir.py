# -*- coding: utf-8 -*-
"""根据网络查询结果，按目录匹配正确歌手名，批量修复。"""
import os, re, subprocess

out = r'\\192.168.3.80\music\all-flacs'
ffmpeg = r'C:\ffmpeg\bin\ffmpeg.exe'

# 按目录路径关键词匹配正确歌手名
DIR_ARTIST_MAP = [
    (r'董文华.*发烧女声', '董文华'),
    (r'彩云之南.*巴乌', '石家环'),
    (r'旅途音乐地图', '群星'),
    (r'双电子琴.*效果音乐', '群星'),
    (r'汽车音响专用音乐.*发烧天碟', '群星'),
    (r'发烧民乐.*听遍中国', '群星'),
    (r'最新流行发烧金曲', '群星'),
    (r'发烧琴韵.*电子琴', '群星'),
    (r'草原天堂.*发烧', '群星'),
    (r'汽车音乐.*移动的音乐厅', '群星'),
    (r'西藏音乐之旅', '群星'),
    (r'绝对发烧\s*18', None),  # 从歌名括号提取
    (r'雨果发烧碟', '群星'),
    (r'高原的呼唤', '群星'),
    (r'传奇绝美靓声', '群星'),
    (r'发烧试音碟.*金耳朵', '群星'),
    (r'集结号.*小号', '群星'),
    (r'惠威试音碟', '群星'),
]

BRACKET_ARTIST_RE = re.compile(r'^(.+?)[（(]([^（）()]{2,8})[）)]$')
VERSION_WORDS = {'国语版', '粤语版', '原创', '翻唱', '伴奏', '纯音乐', '演奏版', '小提琴版', '钢琴版', '吉他版', '萨克斯版', 'DTS', 'DSD', 'HQCD', 'SQCD'}

fixed = 0
bracket_extract = 0
errors = 0
skipped = 0

for dp, dns, fns in os.walk(out):
    for fn in fns:
        if not fn.endswith('.flac'): continue
        old_path = os.path.join(dp, fn)
        name = fn[:-5]
        parts = name.split('-', 3)
        if len(parts) != 4: continue
        artist, title, lang, style = parts
        rel = os.path.relpath(dp, out)
        
        new_artist = artist
        new_title = title
        
        # 按目录匹配
        matched = False
        for pattern, target in DIR_ARTIST_MAP:
            if re.search(pattern, rel):
                matched = True
                if target is not None:
                    new_artist = target
                else:
                    # 绝对发烧18：从歌名括号提取
                    m = BRACKET_ARTIST_RE.match(title)
                    if m:
                        candidate = m.group(2).strip()
                        if candidate not in VERSION_WORDS and not re.match(r'^[\d\s\.\-]+$', candidate):
                            new_artist = candidate
                            new_title = m.group(1).strip()
                            bracket_extract += 1
                    else:
                        new_artist = '群星'
                break
        
        if not matched:
            # 检查歌手是否是论坛名/专辑名等异常值
            bad_patterns = [r'论坛', r'^群星·', r'^响·发烧', r'^民族之响韵', r'^发烧试音碟$', r'^DTS音乐?$', r'^网络男声$', r'^\[炫音音乐论坛\]']
            if any(re.search(p, artist) for p in bad_patterns):
                new_artist = '群星'
                matched = True
        
        if not matched or new_artist == artist:
            skipped += 1
            continue
        
        new_fn = f'{new_artist}-{new_title}-{lang}-{style}.flac'
        new_path = os.path.join(dp, new_fn)
        if new_path == old_path:
            continue
        
        try:
            tmp_path = new_path + '.tmp'
            cmd = [ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-i', old_path,
                   '-map', '0:a', '-c:a', 'copy', '-f', 'flac',
                   '-metadata', f'TITLE={new_title}',
                   '-metadata', f'ARTIST={new_artist}',
                   tmp_path]
            p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if p.returncode == 0 and os.path.exists(tmp_path):
                os.replace(tmp_path, new_path)
                if old_path != new_path and os.path.exists(old_path):
                    os.remove(old_path)
                fixed += 1
                if fixed <= 15:
                    print(f'  {artist} → {new_artist}: {new_title}')
            else:
                errors += 1
        except Exception as e:
            errors += 1

print(f'\n修复: {fixed} 个')
print(f'括号提取歌手: {bracket_extract} 个')
print(f'跳过: {skipped} 个')
print(f'错误: {errors} 个')
