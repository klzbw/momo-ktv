# -*- coding: utf-8 -*-
"""单目录转码：只处理指定的整轨目录。"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from flac_convert import process_album, parse_cue, read_text_auto, FFMPEG

src_dir = r'\\192.168.3.80\music\02 现代、流行音乐【无损音乐】\著名的小提琴返场小品2CD[WAV+CUE]\小提琴返场小品2CD-CDB'
out_root = r'\\192.168.3.80\music\all-flacs'
root = r'\\192.168.3.80\music'

cues = [f for f in os.listdir(src_dir) if f.lower().endswith('.cue')]
wholes = [f for f in os.listdir(src_dir) if f.lower().endswith(('.wav', '.ape', '.flac', '.tta', '.wv'))]
if not cues:
    print('没有找到cue文件')
    sys.exit(1)

job = {'dir': src_dir, 'cues': cues, 'whole': wholes}
args = (src_dir, job, root, out_root, True)
r = process_album(args)
print(f'\n结果: ok={r.get("ok")} skip={r.get("skip")} fail={len(r.get("fail", []))}')
if r.get('fail'):
    for f in r['fail'][:5]:
        print(f'  失败: {f}')
