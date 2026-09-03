# -*- coding: utf-8 -*-
"""转码孙露寂寞的夜9的两个CD。"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from flac_convert import process_album

root = r'\\192.168.3.80\music'
out_root = r'\\192.168.3.80\music\all-flacs'
base = r'\\192.168.3.80\music\爱DTS【无损音乐】\孙露 65CD+99首+43首【无损音乐】\孙露 寂寞的夜 （1-10）20CD\DTS-孙露《寂寞的夜09》2CD'

for cd in ['孙露《寂寞的夜9》CD1[WAV]', '孙露《寂寞的夜9》CD2[WAV]']:
    src_dir = os.path.join(base, cd)
    print(f'\n=== {cd} ===')
    cues = [f for f in os.listdir(src_dir) if f.lower().endswith('.cue')]
    wholes = [f for f in os.listdir(src_dir) if f.lower().endswith(('.wav', '.ape', '.flac', '.tta', '.wv'))]
    job = {'dir': src_dir, 'cues': cues, 'whole': wholes}
    args = (src_dir, job, root, out_root, True)
    r = process_album(args)
    print(f'结果: ok={r.get("ok")} skip={r.get("skip")} fail={len(r.get("fail", []))}')
    if r.get('fail'):
        for f in r['fail'][:3]:
            print(f'  失败: {f}')
