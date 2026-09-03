# -*- coding: utf-8 -*-
import os
d = r'\\192.168.3.80\music\all-flacs\02 现代、流行音乐【无损音乐】\汽车专用精品大碟 梦之车 360度立体音效 2CD'
for dp, dns, fns in os.walk(d):
    rel = os.path.relpath(dp, d)
    flacs = [f for f in fns if f.endswith('.flac')]
    print(f'{rel}: {len(flacs)} 首')
    for f in sorted(flacs)[:5]:
        print(f'  {f}')
    if len(flacs) > 5:
        print(f'  ... 共{len(flacs)}首')
