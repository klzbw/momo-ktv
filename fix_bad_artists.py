# -*- coding: utf-8 -*-
"""批量修复异常歌手名和歌名问题。"""
import os, re, subprocess

out = r'\\192.168.3.80\music\all-flacs'
ffmpeg = r'C:\ffmpeg\bin\ffmpeg.exe'

# 需要替换为群星的歌手名模式
BAD_ARTIST_PATTERNS = [
    (r'^倦鸟馀花论坛$', '群星'),
    (r'^炫音音乐论坛$', '群星'),
    (r'^炫音论坛$', '群星'),
    (r'^炫音论坛－群星$', '群星'),
    (r'^\[炫音音乐论坛\]纯音$', '群星'),
    (r'^枫情音乐论坛$', '群星'),
    (r'^捌零音乐论坛$', '群星'),
    (r'^群星·与您共享.*$', '群星'),
    (r'^群星·老姜与您共享.*$', '群星'),
    (r'^群星《绝对发烧\d+》$', '群星'),
    (r'^响·发烧示范碟.*$', '群星'),
    (r'^民族之响韵.*$', '群星'),
    (r'^发烧试音碟$', '群星'),
    (r'^DTS音乐?$', '群星'),
    (r'^网络男声$', '未知'),
]

# 歌名中括号提取歌手（如"一面湖水(童丽)" → 歌手=童丽, 歌名=一面湖水）
BRACKET_ARTIST_RE = re.compile(r'^(.+?)[（(]([^（）()]{2,8})[）)]$')
# 排除版本说明
VERSION_WORDS = {'国语版', '粤语版', '原创', '翻唱', '伴奏', '纯音乐', '演奏版', '小提琴版', '钢琴版', '吉他版', '萨克斯版', 'DTS', 'DSD', 'HQCD', 'SQCD'}

fixed_artist = 0
fixed_bracket = 0
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
        new_title = title
        
        # 1. 修复异常歌手名
        for pattern, repl in BAD_ARTIST_PATTERNS:
            if re.match(pattern, artist):
                new_artist = repl
                break
        
        # 2. 如果歌手是群星，从歌名括号提取实际歌手
        if new_artist == '群星':
            m = BRACKET_ARTIST_RE.match(title)
            if m:
                candidate = m.group(2).strip()
                if candidate not in VERSION_WORDS and not re.match(r'^[\d\s\.\-]+$', candidate):
                    new_artist = candidate
                    new_title = m.group(1).strip()
                    fixed_bracket += 1
        
        if new_artist != artist or new_title != title:
            new_fn = f'{new_artist}-{new_title}-{lang}-{style}.flac'
            new_path = os.path.join(dp, new_fn)
            if new_path != old_path:
                try:
                    # 用ffmpeg重写metadata并重命名
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
                        fixed_artist += 1
                        if fixed_artist <= 10:
                            print(f'  {fn}')
                            print(f'  → {new_fn}')
                    else:
                        errors += 1
                except Exception as e:
                    errors += 1

print(f'\n修复歌手名: {fixed_artist} 个')
print(f'括号提取歌手: {fixed_bracket} 个')
print(f'错误: {errors} 个')
