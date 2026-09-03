# -*- coding: utf-8 -*-
"""修复情解药A/B的cue，按txt中CD1/CD2曲目，重新转码。"""
import os, re, shutil, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from flac_convert import process_album

base = r'\\192.168.3.80\music\03 群星【无损音乐】\情解药·Hi-Fi心魂 2CD\情解药·Hi-Fi心魂 2CD'
out_base = r'\\192.168.3.80\music\all-flacs\03 群星【无损音乐】\情解药·Hi-Fi心魂 2CD\情解药·Hi-Fi心魂 2CD'
root = r'\\192.168.3.80\music'
out_root = r'\\192.168.3.80\music\all-flacs'

cd1_titles = [
    "等你等了那么久", "我忘了怎么哭", "我终于失去了你", "再见青春", "北京北京",
    "因为爱情", "稳稳的幸福", "囚鸟", "当我想你的时候", "预谋",
    "半梦半醒之间", "谁在窗外流泪", "一万个舍不得", "你的心里有过谁", "谁在意我流下的泪",
]
cd2_titles = [
    "光阴的故事", "男人再晚也别忘了回家", "路人", "离不开你", "风吹麦浪",
    "想念你", "如果没有你", "光阴", "恋人爱人离开我的人", "有点舍不得",
    "好男人都死到哪儿去了", "火火的姑娘", "告诉我亲爱的你", "爱人别走", "存在",
]

def fix_cue(src_dir, cue_name, titles, album_name):
    cue_path = os.path.join(src_dir, cue_name)
    with open(cue_path, 'rb') as f:
        text = f.read().decode('gbk', errors='replace')
    file_line = re.search(r'(FILE "?[^"]*"? WAVE)', text)
    file_str = file_line.group(1) if file_line else 'FILE "CDImage.wav" WAVE'
    pattern = r'TRACK (\d+) AUDIO\s+TITLE "[^"]*"\s+PERFORMER "([^"]*)"\s+(?:FLAGS[^\n]*\s+)?(?:INDEX 00 (\d+:\d+:\d+)\s+)?INDEX 01 (\d+:\d+:\d+)'
    matches = re.findall(pattern, text)
    print(f'  {cue_name}: {len(matches)}首')
    shutil.copy2(cue_path, cue_path + '.bak')
    lines = ['PERFORMER "群星"', f'TITLE "{album_name}"', file_str]
    for i, (no, performer, idx00, idx01) in enumerate(matches):
        title = titles[i] if i < len(titles) else f"音轨{int(no):02d}"
        lines.append(f'  TRACK {int(no):02d} AUDIO')
        lines.append(f'    TITLE "{title}"')
        lines.append(f'    PERFORMER "群星"')
        if idx00:
            lines.append(f'    INDEX 00 {idx00}')
        lines.append(f'    INDEX 01 {idx01}')
    with open(cue_path, 'w', encoding='gbk', errors='replace') as f:
        f.write('\r\n'.join(lines) + '\r\n')

for sub, titles, album in [('情解药A', cd1_titles, '情解药 CD1'), ('情解药B', cd2_titles, '情解药 CD2')]:
    src = os.path.join(base, sub)
    out_dir = os.path.join(out_base, sub)
    print(f'\n=== {sub} ===')
    cues = [f for f in os.listdir(src) if f.lower().endswith('.cue')]
    fix_cue(src, cues[0], titles, album)
    # 删除旧输出
    if os.path.isdir(out_dir):
        old = [f for f in os.listdir(out_dir) if f.endswith('.flac')]
        print(f'  删除旧输出 {len(old)} 个')
        for f in old:
            os.remove(os.path.join(out_dir, f))
    # 转码
    wholes = [f for f in os.listdir(src) if f.lower().endswith(('.wav', '.ape', '.flac', '.tta', '.wv'))]
    job = {'dir': src, 'cues': cues, 'whole': wholes}
    r = process_album((src, job, root, out_root, True))
    print(f'  转码: ok={r.get("ok")} skip={r.get("skip")} fail={len(r.get("fail",[]))}')
    files = sorted([f for f in os.listdir(out_dir) if f.endswith('.flac')])
    print(f'  输出 {len(files)} 首')
    for f in files[:3]:
        print(f'    {f}')
