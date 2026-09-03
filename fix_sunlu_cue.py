# -*- coding: utf-8 -*-
"""修复孙露《寂寞的夜9》2CD的cue文件，按txt曲目列表替换Trackxx。"""
import os, re, shutil

base = r'\\192.168.3.80\music\爱DTS【无损音乐】\孙露 65CD+99首+43首【无损音乐】\孙露 寂寞的夜 （1-10）20CD\DTS-孙露《寂寞的夜09》2CD'

cd1_titles = [
    "爱上你等于爱上寂寞", "计算", "终于等到你", "往日时光", "爱太深",
    "老情歌", "当我想你的时候", "爱的代价", "爱情傻瓜", "红玫瑰",
    "假如爱有天意", "别让我一个人醉", "痛苦时候最寂寞",
]
cd2_titles = [
    "怕什么孤单", "爱人别走", "分手时不哭泣", "梦一场", "爱到不能爱",
    "等你等了那么久", "想你想的很辛苦", "下定决心忘记你", "爱与不爱都是伤害",
    "伤了我的心", "爱是你给我的毒", "伤了心的女人怎么了", "不知道你喜不喜欢这样的我",
]

def fix_cue(cue_path, titles, album_title):
    with open(cue_path, 'rb') as f:
        data = f.read()
    text = data.decode('gbk', errors='replace')
    # 提取每个track的时间戳
    pattern = r'TRACK (\d+) AUDIO\s+TITLE "[^"]*"\s+PERFORMER "([^"]*)"\s+FLAGS DCP\s+(?:INDEX 00 (\d+:\d+:\d+)\s+)?INDEX 01 (\d+:\d+:\d+)'
    matches = re.findall(pattern, text)
    print(f'  提取到 {len(matches)} 个track')
    
    shutil.copy2(cue_path, cue_path + '.bak')
    
    lines = []
    lines.append('PERFORMER "孙露"')
    lines.append(f'TITLE "{album_title}"')
    lines.append('FILE "CDImage.wav" WAVE')
    
    for i, (no, performer, idx00, idx01) in enumerate(matches):
        title = titles[i] if i < len(titles) else f"Track{int(no):02d}"
        lines.append(f'  TRACK {int(no):02d} AUDIO')
        lines.append(f'    TITLE "{title}"')
        lines.append(f'    PERFORMER "{performer}"')
        lines.append('    FLAGS DCP')
        if idx00:
            lines.append(f'    INDEX 00 {idx00}')
        lines.append(f'    INDEX 01 {idx01}')
    
    new_cue = '\r\n'.join(lines) + '\r\n'
    with open(cue_path, 'w', encoding='gbk', errors='replace') as f:
        f.write(new_cue)
    print(f'  已修复 {len(matches)} 首')

# 修复CD1
cd1_dir = os.path.join(base, '孙露《寂寞的夜9》CD1[WAV]')
cd1_cue = os.path.join(cd1_dir, 'CDImage.cue')
print('=== CD1 ===')
fix_cue(cd1_cue, cd1_titles, '寂寞的夜9-1')

# 修复CD2
cd2_dir = os.path.join(base, '孙露《寂寞的夜9》CD2[WAV]')
cd2_cue = os.path.join(cd2_dir, 'CDImage.cue')
print('=== CD2 ===')
fix_cue(cd2_cue, cd2_titles, '寂寞的夜9-2')

print('\n修复完成！')
print('CD1曲目:', '、'.join(cd1_titles[:5]), '...')
print('CD2曲目:', '、'.join(cd2_titles[:5]), '...')
