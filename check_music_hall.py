# -*- coding: utf-8 -*-
import os, re
base = r'\\192.168.3.80\music\02 现代、流行音乐【无损音乐】\音乐殿堂系列 12CD'
for dp, dns, fns in os.walk(base):
    rel = os.path.relpath(dp, base)
    cues = [f for f in fns if f.lower().endswith('.cue')]
    wholes = [f for f in fns if f.lower().endswith(('.wav','.ape','.flac','.tta','.wv'))]
    if cues or wholes:
        print(f'{rel}: cue={len(cues)} whole={len(wholes)}')
        for c in cues:
            cp = os.path.join(dp, c)
            with open(cp, 'rb') as f:
                text = f.read().decode('gbk', errors='replace')
            tracks = re.findall(r'TRACK (\d+)', text)
            perf = re.findall(r'PERFORMER "([^"]+)"', text)
            titles = re.findall(r'TITLE "([^"]+)"', text)
            print(f'  {c}: {len(tracks)}首, 专辑={titles[0] if titles else "?"}, 歌手={perf[0] if perf else "?"}')
            print(f'  曲目: {titles[1:]}')
