# -*- coding: utf-8 -*-
"""修复伍国忠《国色笛香》的cue，13首中文曲名。"""
import os, re, shutil, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from flac_convert import process_album

src = r'\\192.168.3.80\music\02 现代、流行音乐【无损音乐】\汽车专用精品大碟 梦之车 360度立体音效 2CD\汽车专用精品大碟 梦之车 360度立体音效 2CD\汽车专用精品大碟 梦之车 360度立体音效《国色笛香》怡人唱片'
out_dir = r'\\192.168.3.80\music\all-flacs\02 现代、流行音乐【无损音乐】\汽车专用精品大碟 梦之车 360度立体音效 2CD\汽车专用精品大碟 梦之车 360度立体音效 2CD\汽车专用精品大碟 梦之车 360度立体音效《国色笛香》怡人唱片'

titles = [
    "神香", "天边", "达古拉", "枉凝眉", "月光下的凤尾竹",
    "月亮升起来", "吐鲁番的姑娘", "小河淌水", "香格里拉",
    "阿瓦人民唱新歌", "有一个美丽的地方", "请你尝块哈蜜瓜", "神奇的九寨",
]

cue_path = os.path.join(src, 'CDImage.cue')
with open(cue_path, 'rb') as f:
    text = f.read().decode('gbk', errors='replace')

pattern = r'TRACK (\d+) AUDIO\s+TITLE "[^"]*"\s+PERFORMER "([^"]*)"\s+(?:FLAGS[^\n]*\s+)?(?:INDEX 00 (\d+:\d+:\d+)\s+)?INDEX 01 (\d+:\d+:\d+)'
matches = re.findall(pattern, text)
print(f'提取到 {len(matches)} 个track')

shutil.copy2(cue_path, cue_path + '.bak')
lines = ['PERFORMER "伍国忠"', 'TITLE "国色笛香"', 'FILE "CDImage.ape" WAVE']
for i, (no, performer, idx00, idx01) in enumerate(matches):
    title = titles[i] if i < len(titles) else f"Track{int(no):02d}"
    lines.append(f'  TRACK {int(no):02d} AUDIO')
    lines.append(f'    TITLE "{title}"')
    lines.append(f'    PERFORMER "伍国忠"')
    if idx00:
        lines.append(f'    INDEX 00 {idx00}')
    lines.append(f'    INDEX 01 {idx01}')

with open(cue_path, 'w', encoding='gbk', errors='replace') as f:
    f.write('\r\n'.join(lines) + '\r\n')
print('cue已修复')

# 删除旧输出（39个错误文件）
if os.path.isdir(out_dir):
    old = [f for f in os.listdir(out_dir) if f.endswith('.flac')]
    print(f'删除旧输出 {len(old)} 个')
    for f in old:
        os.remove(os.path.join(out_dir, f))

# 转码
root = r'\\192.168.3.80\music'
out_root = r'\\192.168.3.80\music\all-flacs'
cues = [f for f in os.listdir(src) if f.lower().endswith('.cue')]
wholes = [f for f in os.listdir(src) if f.lower().endswith(('.wav', '.ape', '.flac', '.tta', '.wv'))]
job = {'dir': src, 'cues': cues, 'whole': wholes}
r = process_album((src, job, root, out_root, True))
print(f'转码: ok={r.get("ok")} skip={r.get("skip")} fail={len(r.get("fail",[]))}')

# 验证
files = sorted([f for f in os.listdir(out_dir) if f.endswith('.flac')])
print(f'\n输出 {len(files)} 首:')
for f in files:
    print(f'  {f}')
