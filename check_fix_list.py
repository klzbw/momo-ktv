# -*- coding: utf-8 -*-
import os, json
fix_log = r'\\192.168.3.80\music\all-flacs\_track_to_fix.jsonl'
if os.path.exists(fix_log):
    records = []
    seen = set()
    with open(fix_log, 'r', encoding='utf-8') as f:
        for line in f:
            r = json.loads(line.strip())
            if r['dir'] not in seen:
                seen.add(r['dir'])
                records.append(r)
    print('待网络修复的专辑:', len(records), '个')
    for r in records[:30]:
        gc = r['generic_count']
        tc = r['track_count']
        print(f'  [{gc}/{tc}] {r["album"]}')
        print(f'    {r["dir"]}')
else:
    print('暂无待修复记录')
