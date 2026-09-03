# -*- coding: utf-8 -*-
"""修复小提琴返场小品CDB的cue文件，用网易云曲目信息替换Trackxx。"""
import os, re, shutil

d = r'\\192.168.3.80\music\02 现代、流行音乐【无损音乐】\著名的小提琴返场小品2CD[WAV+CUE]\小提琴返场小品2CD-CDB'
cue = os.path.join(d, 'CDImage.cue')

# 网易云节目 1368357673 的曲目列表（中文名称）
titles = [
    "佩尔戈莱西：小行板",
    "舒伯特：小夜曲 D.957 No.4",
    "莫扎特：小步舞曲 选自《D大调嬉游曲》K.334",
    "小步舞曲",
    "舒曼：梦幻曲 Op.15 No.7",
    "德沃夏克：小广板 选自《G大调奏鸣曲》",
    "巴赫/古诺：圣母颂",
    "帕格尼尼：E小调奏鸣曲 Op.3 No.6",
    "维尼亚夫斯基：莫斯科的回忆 Op.6",
    "拉威尔：哈巴涅拉",
    "萨拉萨蒂：流浪者之歌 Op.20",
    "拉莫：快板 选自《羽管键琴曲集》Op.1",
    "弗雷：摇篮曲 Op.23 No.1",
    "拉威尔：茨冈",
    "布鲁赫：民谣之歌（Nigun）",
    "柔板",
]

with open(cue, 'rb') as f:
    data = f.read()
text = data.decode('gbk', errors='replace')

# 提取每个track的时间戳
pattern = r'TRACK (\d+) AUDIO\s+TITLE "[^"]*"\s+PERFORMER "[^"]*"\s+(?:REM[^\n]*\s+)*?INDEX 00 (\d+:\d+:\d+)\s+INDEX 01 (\d+:\d+:\d+)'
matches = re.findall(pattern, text)
print(f'提取到 {len(matches)} 个track的时间戳')

# 备份原cue
shutil.copy2(cue, cue + '.bak')

# 生成新cue
lines = []
lines.append('PERFORMER "格鲁米欧"')
lines.append('TITLE "著名小提琴返场小品 CD2"')
lines.append('REM DISCID E311CF10')
lines.append('REM COMMENT "ExactAudioCopy v0.99pb4"')
lines.append('FILE "CDImage.wav" WAVE')

for i, (no, idx00, idx01) in enumerate(matches):
    title = titles[i] if i < len(titles) else f"Track{int(no):02d}"
    lines.append(f'  TRACK {int(no):02d} AUDIO')
    lines.append(f'    TITLE "{title}"')
    lines.append(f'    PERFORMER "格鲁米欧"')
    lines.append(f'    INDEX 00 {idx00}')
    lines.append(f'    INDEX 01 {idx01}')

new_cue = '\r\n'.join(lines) + '\r\n'
with open(cue, 'w', encoding='gbk', errors='replace') as f:
    f.write(new_cue)

print(f'已更新cue文件，共 {len(matches)} 首')
print('曲目列表:')
for i, t in enumerate(titles[:len(matches)], 1):
    print(f'  {i:2d}. {t}')
