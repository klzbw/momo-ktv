# -*- coding: utf-8 -*-
"""批量修复音乐殿堂系列CD02/CD03/CD06的cue并转码。"""
import os, re, shutil, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from flac_convert import process_album

base_src = r'\\192.168.3.80\music\02 现代、流行音乐【无损音乐】\音乐殿堂系列 12CD'
base_out = r'\\192.168.3.80\music\all-flacs\02 现代、流行音乐【无损音乐】\音乐殿堂系列 12CD'
root = r'\\192.168.3.80\music'
out_root = r'\\192.168.3.80\music\all-flacs'

albums = {
    'CD02': {
        'dir': '音乐殿堂系列12CD之02《著名交响诗》\\音乐殿堂系列12CD之02《著名交响诗》',
        'cue': '音乐殿堂系列12CD之2《著名交响诗》.cue',
        'album': '著名交响诗',
        'titles': [
            "斯美塔那：交响诗《我的祖国》第二曲（沃尔塔瓦河）",
            "斯美塔那：交响诗《我的祖国》第三首（萨尔卡）",
            "德彪西：《牧神午后》",
            "德彪西：交响素描《大海》第一首（从黎明到中午的大海）",
            "德彪西：交响诗《意象》第二部（伊贝利亚）",
            "穆索尔斯基：《荒山之夜》",
            "李斯特：《前奏曲》",
        ],
    },
    'CD03': {
        'dir': '音乐殿堂系列12CD之03《浪漫管弦乐》\\音乐殿堂系列12CD之03《浪漫管弦乐》',
        'cue': '音乐殿堂系列12CD之3《浪漫管弦乐》.cue',
        'album': '浪漫管弦乐',
        'titles': [
            "布拉姆斯：第五号匈牙利舞曲",
            "巴赫-古诺：圣母颂",
            "比才：《卡门》组曲 哈巴涅拉舞曲",
            "格里格：《彼尔·金特》组曲（早晨）",
            "奥芬巴赫：地狱中的奥菲欧（选段）",
            "约翰·施特劳斯：电闪雷鸣波尔卡",
            "威尔第：歌剧《茶花女》前奏曲",
            "海顿：降B大调嬉游曲《圣安东尼合唱》",
            "德彪西：月光",
            "德沃夏克：C大调第一号《斯拉夫舞曲》",
            "里姆斯基-科萨科夫：天方夜谭（年轻的王子与公主）",
            "里姆斯基-科萨科夫：萨尔丹沙皇的故事（野蜂飞舞）",
            "奥芬巴赫：霍夫曼的故事（船歌）",
            "夏布里埃：西班牙狂想曲",
            "圣-桑：《动物狂欢节》（天鹅）",
            "拉威尔：波莱罗舞曲",
        ],
    },
    'CD06': {
        'dir': '音乐殿堂系列12CD之06《优美圆舞曲》\\音乐殿堂系列12CD之06《优美圆舞曲》',
        'cue': '音乐殿堂系列12CD之6《优美圆舞曲》.cue',
        'album': '优美圆舞曲',
        'titles': [
            "约翰·施特劳斯：蓝色多瑙河",
            "约翰·施特劳斯：春之声",
            "约翰·施特劳斯：皇帝圆舞曲",
            "约翰·施特劳斯：维也纳森林的故事",
            "约翰·施特劳斯：南国玫瑰",
            "约翰·施特劳斯：维也纳的气质",
            "德利布：《葛蓓莉亚》圆舞曲",
            "柴可夫斯基：《胡桃夹子》花之圆舞曲",
            "柴可夫斯基：《C大调弦乐小夜曲》圆舞曲",
            "韦伯：邀舞",
            "拉威尔：圆舞曲",
            "肖邦：华丽大圆舞曲",
        ],
    },
}

for cd_key, info in albums.items():
    src = os.path.join(base_src, info['dir'])
    out_dir = os.path.join(base_out, info['dir'])
    cue_path = os.path.join(src, info['cue'])
    
    if not os.path.exists(cue_path):
        print(f'{cd_key}: cue不存在 {cue_path}')
        # 查找实际cue名
        cues = [f for f in os.listdir(src) if f.lower().endswith('.cue')]
        if cues:
            cue_path = os.path.join(src, cues[0])
            print(f'  使用: {cues[0]}')
        else:
            print(f'  跳过')
            continue
    
    with open(cue_path, 'rb') as f:
        text = f.read().decode('gbk', errors='replace')
    
    file_line = re.search(r'(FILE "?[^"]*"? WAVE)', text)
    file_str = file_line.group(1) if file_line else 'FILE "CDImage.ape" WAVE'
    
    pattern = r'TRACK (\d+) AUDIO\s+TITLE "[^"]*"\s+PERFORMER "([^"]*)"\s+(?:FLAGS[^\n]*\s+)?(?:INDEX 00 (\d+:\d+:\d+)\s+)?INDEX 01 (\d+:\d+:\d+)'
    matches = re.findall(pattern, text)
    print(f'{cd_key}: {len(matches)} 个track, 期望{len(info["titles"])}首')
    
    shutil.copy2(cue_path, cue_path + '.bak')
    lines = ['PERFORMER "群星"', f'TITLE "{info["album"]}"', file_str]
    for i, (no, performer, idx00, idx01) in enumerate(matches):
        title = info['titles'][i] if i < len(info['titles']) else f"Track{int(no):02d}"
        lines.append(f'  TRACK {int(no):02d} AUDIO')
        lines.append(f'    TITLE "{title}"')
        lines.append(f'    PERFORMER "群星"')
        if idx00:
            lines.append(f'    INDEX 00 {idx00}')
        lines.append(f'    INDEX 01 {idx01}')
    
    with open(cue_path, 'w', encoding='gbk', errors='replace') as f:
        f.write('\r\n'.join(lines) + '\r\n')
    print(f'  cue已修复')
    
    # 删除旧输出
    if os.path.isdir(out_dir):
        old = [f for f in os.listdir(out_dir) if f.endswith('.flac')]
        print(f'  删除旧输出 {len(old)} 个')
        for f in old:
            os.remove(os.path.join(out_dir, f))
    
    # 转码
    cues = [f for f in os.listdir(src) if f.lower().endswith('.cue')]
    wholes = [f for f in os.listdir(src) if f.lower().endswith(('.wav', '.ape', '.flac', '.tta', '.wv'))]
    job = {'dir': src, 'cues': cues, 'whole': wholes}
    r = process_album((src, job, root, out_root, True))
    print(f'  转码: ok={r.get("ok")} skip={r.get("skip")} fail={len(r.get("fail",[]))}')
    
    files = sorted([f for f in os.listdir(out_dir) if f.endswith('.flac')])
    print(f'  输出 {len(files)} 首')
    print()
