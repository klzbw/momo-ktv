# -*- coding: utf-8 -*-
import os
out_a = r'\\192.168.3.80\music\all-flacs\03 群星【无损音乐】\情解药·Hi-Fi心魂 2CD\情解药·Hi-Fi心魂 2CD\情解药A'
out_b = r'\\192.168.3.80\music\all-flacs\03 群星【无损音乐】\情解药·Hi-Fi心魂 2CD\情解药·Hi-Fi心魂 2CD\情解药B'
for name, d in [('情解药A', out_a), ('情解药B', out_b)]:
    if os.path.isdir(d):
        files = sorted([f for f in os.listdir(d) if f.endswith('.flac')])
        print(f'{name}: {len(files)} 首')
        for f in files[:5]:
            print(f'  {f}')
        if len(files) > 5:
            print(f'  ... 共{len(files)}首')
    else:
        print(f'{name}: 目录不存在')
