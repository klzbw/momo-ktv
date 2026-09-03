# -*- coding: utf-8 -*-
"""修复小提琴返场小品CDA的cue，用美篇CD1曲目列表替换Trackxx。"""
import os, re, shutil, subprocess

src = r'\\192.168.3.80\music\02 现代、流行音乐【无损音乐】\著名的小提琴返场小品2CD[WAV+CUE]\小提琴返场小品2CD-CDA'
out_dir = r'\\192.168.3.80\music\all-flacs\02 现代、流行音乐【无损音乐】\著名的小提琴返场小品2CD[WAV+CUE]\小提琴返场小品2CD-CDA'
ffmpeg = r'C:\ffmpeg\bin\ffmpeg.exe'

# 美篇CD1 24首中文曲名
titles = [
    "帕拉迪斯：西西里舞曲",
    "莫扎特：回旋曲 K.250",
    "格鲁克：旋律",
    "格拉纳多斯：西班牙舞曲第5号 安达卢西亚",
    "克莱斯勒：美丽的罗斯玛琳",
    "克莱斯勒：爱之悲伤",
    "克莱斯勒：爱之欢乐",
    "维拉奇尼：快板",
    "维瓦尔第：西西里舞曲 Op.3 No.11",
    "勒克莱尔：铃鼓舞曲",
    "贝多芬：G大调小步舞曲 WoO 10 No.2",
    "舒伯特：圣母颂 Op.52 No.6",
    "德沃夏克：幽默曲 Op.101 No.7",
    "马斯涅：沉思 选自《泰伊思》",
    "柴可夫斯基：感伤圆舞曲 Op.51 No.6",
    "维拉奇尼-科尔蒂：广板",
    "克莱斯勒：贝多芬主题回旋曲",
    "克莱斯勒：马蒂尼风格小行板",
    "埃尔加：随想曲",
    "弗雷：梦后 Op.7 No.1",
    "阿尔贝尼兹：探戈 Op.165 No.2",
    "韦切伊：悲伤圆舞曲",
    "庞塞：小星星",
    "西贝柳斯：夜曲 Op.51 No.3",
]

cue_path = os.path.join(src, 'CDImage.cue')
with open(cue_path, 'rb') as f:
    text = f.read().decode('gbk', errors='replace')

# 提取每个track的时间戳
pattern = r'TRACK (\d+) AUDIO\s+TITLE "[^"]*"\s+PERFORMER "[^"]*"\s+(?:REM[^\n]*\s+)*?INDEX 00 (\d+:\d+:\d+)\s+INDEX 01 (\d+:\d+:\d+)'
matches = re.findall(pattern, text)
# 有些track可能只有INDEX 01，用更宽松的pattern
if len(matches) < 24:
    pattern2 = r'TRACK (\d+) AUDIO\s+TITLE "[^"]*"\s+PERFORMER "[^"]*"\s+(?:FLAGS[^\n]*\s+)?(?:INDEX 00 (\d+:\d+:\d+)\s+)?INDEX 01 (\d+:\d+:\d+)'
    matches = re.findall(pattern2, text)

print(f'提取到 {len(matches)} 个track')

shutil.copy2(cue_path, cue_path + '.bak')

lines = ['PERFORMER "格鲁米欧"', 'TITLE "至爱小提琴返场曲辑 CD1"', 'FILE "CDImage.wav" WAVE']
for i, (no, idx00, idx01) in enumerate(matches):
    title = titles[i] if i < len(titles) else f"Track{int(no):02d}"
    lines.append(f'  TRACK {int(no):02d} AUDIO')
    lines.append(f'    TITLE "{title}"')
    lines.append('    PERFORMER "格鲁米欧"')
    if idx00:
        lines.append(f'    INDEX 00 {idx00}')
    lines.append(f'    INDEX 01 {idx01}')

with open(cue_path, 'w', encoding='gbk', errors='replace') as f:
    f.write('\r\n'.join(lines) + '\r\n')
print('cue已修复')

# 删除旧输出
if os.path.isdir(out_dir):
    old = [f for f in os.listdir(out_dir) if f.endswith('.flac')]
    print(f'删除旧输出 {len(old)} 个')
    for f in old:
        os.remove(os.path.join(out_dir, f))

# 转码
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from flac_convert import process_album
root = r'\\192.168.3.80\music'
out_root = r'\\192.168.3.80\music\all-flacs'
cues = [f for f in os.listdir(src) if f.lower().endswith('.cue')]
wholes = [f for f in os.listdir(src) if f.lower().endswith(('.wav', '.ape', '.flac', '.tta', '.wv'))]
job = {'dir': src, 'cues': cues, 'whole': wholes}
r = process_album((src, job, root, out_root, True))
print(f'\n转码结果: ok={r.get("ok")} skip={r.get("skip")} fail={len(r.get("fail", []))}')
if r.get('fail'):
    for f in r['fail'][:3]:
        print(f'  失败: {f}')

# 验证输出
files = sorted([f for f in os.listdir(out_dir) if f.endswith('.flac')])
print(f'\n输出 {len(files)} 首:')
for f in files:
    print(f'  {f}')
