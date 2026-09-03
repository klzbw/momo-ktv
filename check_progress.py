# -*- coding: utf-8 -*-
import os
log = r'\\192.168.3.80\music\all-flacs\_convert_log.jsonl'
if os.path.exists(log):
    lines = open(log, 'r', encoding='utf-8').readlines()
    print('转换日志记录:', len(lines), '条')
out = r'\\192.168.3.80\music\all-flacs'
count = 0
for dp, dns, fns in os.walk(out):
    count += len([f for f in fns if f.endswith('.flac')])
print('all-flacs 总FLAC数:', count)
