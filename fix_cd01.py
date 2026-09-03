# -*- coding: utf-8 -*-
"""修复音乐殿堂系列CD01《十大交响曲》的cue。"""
import os, re, shutil, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from flac_convert import process_album

src = r'\\192.168.3.80\music\02 现代、流行音乐【无损音乐】\音乐殿堂系列 12CD\音乐殿堂系列12CD之01《十大交响曲》\音乐殿堂系列12CD之01《十大交响曲》'
out_dir = r'\\192.168.3.80\music\all-flacs\02 现代、流行音乐【无损音乐】\音乐殿堂系列 12CD\音乐殿堂系列12CD之01《十大交响曲》\音乐殿堂系列12CD之01《十大交响曲》'

titles = [
    "贝多芬：第五交响曲《命运》",
    "德沃夏克：第九交响曲《新世界》",
    "莫扎特：第四十一交响曲《朱庇特》",
    "舒伯特：b小调第八交响曲《未完成》",
    "海顿：第九十四交响曲《惊愕》",
    "柴可夫斯基：第六交响曲《悲怆》",
    "舒曼：第一交响曲《春天》",
    "布拉姆斯：第一交响曲",
    "门德尔松：第四交响曲《意大利》",
    "贝多芬：第九交响曲《合唱》",
]

cue_path = os.path.join(src, '音乐殿堂系列12CD之1《十大交响曲》.cue')
with open(cue_path, 'rb') as f:
    text = f.read().decode('gbk', errors='replace')

file_line = re.search(r'(FILE "?[^"]*"? WAVE)', text)
file_str = file_line.group(1) if file_line else 'FILE "CDImage.ape" WAVE'

pattern = r'TRACK (\d+) AUDIO\s+TITLE "[^"]*"\s+PERFORMER "([^"]*)"\s+(?:FLAGS[^\n]*\s+)?(?:INDEX 00 (\d+:\d+:\d+)\s+)?INDEX 01 (\d+:\d+:\d+)'
matches = re.findall(pattern, text)
print(f'CD01: {len(matches)} 个track, FILE={file_str}')

shutil.copy2(cue_path, cue_path + '.bak')
lines = ['PERFORMER "群星"', 'TITLE "十大交响曲"', file_str]
for i, (no, performer, idx00, idx01) in enumerate(matches):
    title = titles[i] if i < len(titles) else f"Track{int(no):02d}"
    lines.append(f'  TRACK {int(no):02d} AUDIO')
    lines.append(f'    TITLE "{title}"')
    lines.append(f'    PERFORMER "群星"')
    if idx00:
        lines.append(f'    INDEX 00 {idx00}')
    lines.append(f'    INDEX 01 {idx01}')

with open(cue_path, 'w', encoding='gbk', errors='replace') as f:
    f.write('\r\n'.join(lines) + '\r\n')
print('cue已修复')

if os.path.isdir(out_dir):
    old = [f for f in os.listdir(out_dir) if f.endswith('.flac')]
    print(f'删除旧输出 {len(old)} 个')
    for f in old:
        os.remove(os.path.join(out_dir, f))

root = r'\\192.168.3.80\music'
out_root = r'\\192.168.3.80\music\all-flacs'
cues = [f for f in os.listdir(src) if f.lower().endswith('.cue')]
wholes = [f for f in os.listdir(src) if f.lower().endswith(('.wav', '.ape', '.flac', '.tta', '.wv'))]
job = {'dir': src, 'cues': cues, 'whole': wholes}
r = process_album((src, job, root, out_root, True))
print(f'转码: ok={r.get("ok")} skip={r.get("skip")} fail={len(r.get("fail",[]))}')

files = sorted([f for f in os.listdir(out_dir) if f.endswith('.flac')])
print(f'\n输出 {len(files)} 首:')
for f in files:
    print(f'  {f}')
