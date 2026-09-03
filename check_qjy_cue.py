# -*- coding: utf-8 -*-
import os, re
base = r'\\192.168.3.80\music\03 群星【无损音乐】\情解药·Hi-Fi心魂 2CD\情解药·Hi-Fi心魂 2CD'
for sub in ['情解药A', '情解药B']:
    dp = os.path.join(base, sub)
    cues = [f for f in os.listdir(dp) if f.lower().endswith('.cue')]
    for c in cues:
        cp = os.path.join(dp, c)
        with open(cp, 'rb') as f:
            text = f.read().decode('gbk', errors='replace')
        tracks = re.findall(r'TRACK (\d+)', text)
        titles = re.findall(r'TITLE "([^"]+)"', text)
        perf = re.findall(r'PERFORMER "([^"]+)"', text)
        print(f'{sub}/{c}: {len(tracks)}首')
        print(f'  专辑: {titles[0] if titles else "?"}')
        print(f'  歌手: {perf[0] if perf else "?"}')
        print(f'  前3首: {titles[1:4]}')
        print(f'  后3首: {titles[-3:]}')
