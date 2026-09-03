# -*- coding: utf-8 -*-
"""phase2_clean_title.py —— 清理歌名中的序号前缀，只重命名。"""
import os, re, sys, time

if hasattr(sys.stdout, 'reconfigure'):
    try: sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception: pass

OUT_ROOT = r'\\192.168.3.80\music\all-flacs'

def clean_title_prefix(title):
    t = re.sub(r'^\d{1,3}\s*[、.．\-—\s]\s*', '', title or '')
    t = re.sub(r'^第\d{1,3}[首曲目]\s*', '', t)
    return t.strip()

def main():
    renamed = 0
    skipped = 0
    failed = 0
    t0 = time.time()
    for dp, dns, fns in os.walk(OUT_ROOT):
        for fn in fns:
            if not fn.lower().endswith('.flac'): continue
            base = fn[:-5]
            parts = base.split('-', 3)
            if len(parts) != 4: continue
            artist, title, lang, style = parts
            new_title = clean_title_prefix(title)
            if new_title == title:
                skipped += 1
                continue
            new_fn = f'{artist}-{new_title}-{lang}-{style}.flac'
            if new_fn == fn: continue
            old_path = os.path.join(dp, fn)
            new_path = os.path.join(dp, new_fn)
            if os.path.exists(new_path) and new_path != old_path:
                bn = new_fn[:-5]
                i = 2
                while os.path.exists(os.path.join(dp, bn + f'({i}).flac')): i += 1
                new_fn = bn + f'({i}).flac'
                new_path = os.path.join(dp, new_fn)
            try:
                os.rename(old_path, new_path)
                renamed += 1
                if renamed % 100 == 0:
                    print(f'  已修复 {renamed} 个，用时 {time.time()-t0:.0f}s')
            except Exception as e:
                print(f'[FAIL] {fn}: {e}')
                failed += 1
    print(f'\n完成: 修复={renamed} 跳过={skipped} 失败={failed} 用时={time.time()-t0:.0f}s')

if __name__ == '__main__':
    main()
