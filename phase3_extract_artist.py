# -*- coding: utf-8 -*-
"""phase3_extract_artist.py —— 从群星歌曲的歌名括号中提取实际歌手名。"""
import os, re, sys, time

if hasattr(sys.stdout, 'reconfigure'):
    try: sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception: pass

OUT_ROOT = r'\\192.168.3.80\music\all-flacs'

VERSION_KW = ['版','原创','国语','粤语','英语','日语','韩语','伴奏','Demo','Remix','Live',
              '对比','新编','精选','现场','演唱会','卡拉OK','KTV','纯音乐','演奏','演奏版',
              '二胡','古筝','钢琴','小提琴','大提琴','吉他','萨克斯','笛子','洞箫','古琴',
              '琵琶','扬琴','唢呐','马头琴','手风琴','口琴','架子鼓','鼓','贝斯','电子琴',
              '双电子琴','中提琴','低音提琴','长笛','短笛','单簧管','双簧管','小号','长号',
              '圆号','大号','定音鼓','木琴','钟琴','管风琴','竖琴','键盘','合成器','风琴',
              '童声','合唱','齐唱','领唱','伴唱','和声','独白','旁白','朗诵','对白','插曲',
              '主题曲','片头曲','片尾曲','主题曲','片头曲','片尾曲','片头曲','片尾曲',
              '主题曲','片头曲','片尾曲','片头曲','片尾曲']

def extract_artist_from_paren(title):
    """从歌名括号中提取歌手名，返回 (new_title, artist) 或 (None, None)。"""
    m = re.search(r'[（(](.*?)[）)]', title)
    if not m:
        return None, None
    content = m.group(1).strip()
    # 版本说明，不提取
    if any(kw in content for kw in VERSION_KW):
        return None, None
    # 处理"童声：牛湘茗"格式
    if '：' in content or ':' in content:
        parts = re.split(r'[：:]', content, 1)
        if len(parts) == 2 and parts[1].strip():
            artist = parts[1].strip()
            new_title = title[:m.start()] + title[m.end():]
            new_title = re.sub(r'\s+', ' ', new_title).strip(' -_·')
            return new_title, artist
    # 处理"降央卓玛VS小曾"格式
    artist = content
    # 检查是否像人名（中文、空格、&、·、、VS、vs等）
    if len(artist) <= 15 and re.match(r'^[\u4e00-\u9fa5\s&·、VSvs\.]+$', artist):
        new_title = title[:m.start()] + title[m.end():]
        new_title = re.sub(r'\s+', ' ', new_title).strip(' -_·')
        if new_title:  # 确保歌名不为空
            return new_title, artist
    return None, None

def main():
    renamed = 0
    skipped = 0
    failed = 0
    t0 = time.time()
    samples = []
    for dp, dns, fns in os.walk(OUT_ROOT):
        for fn in fns:
            if not fn.lower().endswith('.flac'): continue
            base = fn[:-5]
            parts = base.split('-', 3)
            if len(parts) != 4: continue
            artist, title, lang, style = parts
            if artist not in ('群星', 'Various Artists', 'VA'): continue
            new_title, new_artist = extract_artist_from_paren(title)
            if not new_artist:
                skipped += 1
                continue
            new_fn = f'{new_artist}-{new_title}-{lang}-{style}.flac'
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
                if len(samples) < 15:
                    samples.append(f'{artist} - {title} -> {new_artist} - {new_title}')
                if renamed % 50 == 0:
                    print(f'  已提取 {renamed} 个，用时 {time.time()-t0:.0f}s')
            except Exception as e:
                print(f'[FAIL] {fn}: {e}')
                failed += 1
    print(f'\n完成: 提取歌手={renamed} 跳过={skipped} 失败={failed} 用时={time.time()-t0:.0f}s')
    print()
    print('=== 样例 ===')
    for s in samples:
        print(f'  {s}')

if __name__ == '__main__':
    main()
