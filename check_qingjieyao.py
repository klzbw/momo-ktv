# -*- coding: utf-8 -*-
import os, re
base = r'\\192.168.3.80\music\03 群星【无损音乐】\情解药·Hi-Fi心魂 2CD'
for dp, dns, fns in os.walk(base):
    rel = os.path.relpath(dp, base)
    print(f'{rel}:')
    for f in sorted(fns):
        fp = os.path.join(dp, f)
        size = os.path.getsize(fp)
        print(f'  {f} ({size//1024}KB)')
        # 如果是txt，读取内容
        if f.lower().endswith('.txt') and size < 50000:
            try:
                with open(fp, 'rb') as fh:
                    content = fh.read().decode('gbk', errors='replace')
                print(f'    内容: {content[:500]}')
            except:
                pass
