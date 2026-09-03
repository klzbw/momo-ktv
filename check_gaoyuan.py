# -*- coding: utf-8 -*-
import os, re
base = r'\\192.168.3.80\music\04 草原、高原歌曲【无损音乐】\高原的呼唤ⅡSTS+SRS'
for dp, dns, fns in os.walk(base):
    rel = os.path.relpath(dp, base)
    cues = [f for f in fns if f.lower().endswith('.cue')]
    for c in cues:
        cp = os.path.join(dp, c)
        with open(cp, 'rb') as f:
            text = f.read().decode('gbk', errors='replace')
        tracks = re.findall(r'TRACK (\d+)', text)
        perf = re.findall(r'PERFORMER "([^"]+)"', text)
        titles = re.findall(r'TITLE "([^"]+)"', text)
        print(f'{rel}\\{c}: {len(tracks)}首')
        print(f'  专辑={titles[0] if titles else "?"}')
        print(f'  歌手={perf[0] if perf else "?"}')
        print(f'  曲目={titles[1:]}')
