# -*- coding: utf-8 -*-
import os, re

src = r'\\192.168.3.80\music\02 现代、流行音乐【无损音乐】\著名的小提琴返场小品2CD[WAV+CUE]\小提琴返场小品2CD-CDA'
out = r'\\192.168.3.80\music\all-flacs\02 现代、流行音乐【无损音乐】\著名的小提琴返场小品2CD[WAV+CUE]\小提琴返场小品2CD-CDA'

print('=== 源目录 ===')
print('存在:', os.path.isdir(src))
if os.path.isdir(src):
    for f in os.listdir(src):
        fp = os.path.join(src, f)
        print(f'  {f} ({os.path.getsize(fp)//1024//1024} MB)')
    cue = os.path.join(src, 'CDImage.cue')
    if os.path.exists(cue):
        with open(cue, 'rb') as fh:
            text = fh.read().decode('gbk', errors='replace')
        titles = re.findall(r'TITLE "([^"]+)"', text)
        performers = re.findall(r'PERFORMER "([^"]+)"', text)
        print(f'  cue曲目数: {len(titles)}')
        print(f'  专辑PERFORMER: {performers[0] if performers else "N/A"}')
        for i, t in enumerate(titles, 1):
            print(f'    {i:2d}. {t}')

print()
print('=== 输出目录 ===')
print('存在:', os.path.isdir(out))
if os.path.isdir(out):
    files = sorted([f for f in os.listdir(out) if f.endswith('.flac')])
    print(f'  输出文件数: {len(files)}')
    for f in files:
        print(f'    {f}')
