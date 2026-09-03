# -*- coding: utf-8 -*-
"""修复HI-FI极品靓声3CD的音轨序号歌名，用正确歌手名。"""
import os, re

out = r'\\192.168.3.80\music\all-flacs'

CDS = {
    1: [
        ("伤不起", "马小郡"), ("今生缘", "雷婷"), ("滴答", "佩佩"), ("女人泪", "孙露"),
        ("佛说", "何晟铭"), ("把爱深藏", "阿强"), ("对爱期待", "黄小琥"), ("相思雨", "央金兰泽"),
        ("爱的供养", "刘紫玲"), ("我们的歌谣", "张伟伽"), ("一生无悔", "高安"), ("三寸天堂", "马小郡"),
        ("重来", "王子月"), ("万物生", "萨顶顶"), ("吻你", "龚玥"), ("漂亮的姑娘就要嫁人啦", "周虹"),
    ],
    2: [
        ("因为爱情", "南妮"), ("死而无憾", "刘科"), ("春天里", "阿强"), ("爱的供养", "邓杰"),
        ("老男孩", "阿强"), ("偷偷的哭", "雷婷"), ("等一个晴天", "陈影"), ("红尘情歌", "黑鸭子"),
        ("很有味道", "陈洁仪"), ("毒药", "雨天"), ("小三", "邓杰"), ("莲心", "钟明秋"),
        ("走天涯", "降央卓玛"), ("爱上草原爱上你", "龚玥"), ("别用下辈子安慰我", "陈瑞"),
        ("说再见不应该在秋天", "栗雅馨"), ("你把爱情给了谁", "江智民"),
    ],
    3: [
        ("等不到的爱", "钟明秋"), ("梦中的额吉", "罗海英"), ("大声唱", "凤凰传奇"), ("无法原谅", "雨天"),
        ("赤裸离开", "艾迪"), ("奔向你", "钟明秋"), ("我从雪山来", "龚玥"), ("不想回家的女人", "大哲"),
        ("梦的翅膀受了伤", "段玫梅"), ("漂亮的姑娘就要嫁人啦", "龙梅子"), ("我在乎的是你", "大哲"),
        ("缘分惹的祸", "涓子"), ("雨花石", "李雨儿"), ("云朵", "云朵"), ("恩惠", "萨顶顶"),
        ("最后一次", "周虹"), ("别再说", "张玮伽"),
    ],
}

fixed = 0
for dp, dns, fns in os.walk(out):
    rel = os.path.relpath(dp, out)
    m = re.search(r'极品靓声[-\s]*CD(\d)', rel)
    if not m:
        continue
    cd = int(m.group(1))
    if cd not in CDS:
        continue
    tracks = CDS[cd]
    
    for fn in fns:
        if not fn.endswith('.flac'): continue
        name = fn[:-5]
        parts = name.split('-', 3)
        if len(parts) != 4: continue
        artist, title, lang, style = parts
        tm = re.match(r'^音轨序号(\d+)', title)
        if not tm:
            continue
        idx = int(tm.group(1)) - 1
        if idx >= len(tracks):
            continue
        new_title, new_artist = tracks[idx]
        new_fn = f'{new_artist}-{new_title}-{lang}-{style}.flac'
        old_path = os.path.join(dp, fn)
        new_path = os.path.join(dp, new_fn)
        try:
            if os.path.exists(new_path):
                os.remove(old_path)
            else:
                os.rename(old_path, new_path)
            fixed += 1
        except Exception as e:
            print(f'错误: {fn}: {e}')

print(f'修复HI-FI极品靓声: {fixed} 个')
