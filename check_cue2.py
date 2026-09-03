# -*- coding: utf-8 -*-
import os, re
cue = r'\\192.168.3.80\music\02 现代、流行音乐【无损音乐】\汽车专用精品大碟 梦之车 360度立体音效 2CD\汽车专用精品大碟 梦之车 360度立体音效 2CD\汽车专用精品大碟 梦之车 360度立体音效《国色笛香》怡人唱片\CDImage.cue'
with open(cue, 'rb') as f:
    text = f.read().decode('gbk', errors='replace')
tracks = re.findall(r'TRACK (\d+)', text)
titles = re.findall(r'TITLE "([^"]+)"', text)
print('TRACK数:', len(tracks))
print('TITLE数:', len(titles))
print('前5个TITLE:', titles[:5])
print('后5个TITLE:', titles[-5:])
m = re.search(r'FILE.*', text)
print('FILE行:', m.group() if m else 'N/A')
print()
print('完整cue前1500字符:')
print(text[:1500])
