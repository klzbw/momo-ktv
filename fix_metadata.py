# -*- coding: utf-8 -*-
"""批量修复 all-flacs 中所有 FLAC 文件的 metadata。
从文件名（歌手-歌名-语种-风格.flac）解析正确信息，重写 TITLE/ARTIST/GENRE/LANGUAGE。
不读取现有metadata（避免编码问题），ALBUM从目录名推断。
保留音频流不变（-c:a copy），20并发。"""
import os, re, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed

OUT = r'\\192.168.3.80\music\all-flacs'
FFMPEG = r'C:\ffmpeg\bin\ffmpeg.exe'
WORKERS = 20

def infer_album_from_dir(fp):
    """从文件路径推断专辑名。"""
    parts = fp.split(os.sep)
    # 找含CD或专辑关键词的目录名
    for p in reversed(parts[:-1]):
        if re.search(r'(CD\d|CD[A-Z]|DISC|专辑|《|》|\[)', p):
            # 清理格式标记
            album = re.sub(r'\[(WAV|APE|FLAC|DTS|DSD|HQCD|K2HD|XRCD|LP|黑胶)[^\]]*\]', '', p, flags=re.I)
            album = re.sub(r'[（(][^）)]*(WAV|APE|FLAC|DTS|DSD|整轨|分轨|无损)[^）)]*[）)]', '', album, flags=re.I)
            return album.strip(' -_·')
    # 用父目录名
    if len(parts) >= 2:
        return parts[-2].strip(' -_·')
    return ''

def fix_metadata(fp):
    """修复单个文件的metadata。返回 (是否修改, 信息)。"""
    fn = os.path.basename(fp)
    if not fn.endswith('.flac'):
        return False, 'not flac'
    name = fn[:-5]
    parts = name.split('-', 3)
    if len(parts) != 4:
        return False, 'bad name'
    artist, title, lang, style = parts
    # 清理歌名中的序号前缀
    clean_title = re.sub(r'^\d{1,3}[\.\、\s\-]\s*', '', title)
    # 从括号提取歌手（如果artist是群星）
    if artist == '群星':
        m = re.search(r'[（(](.*?)[）)]', clean_title)
        if m:
            content = m.group(1).strip()
            version_kw = ['版','国语','粤语','英语','日语','韩语','伴奏','Demo','Remix','Live',
                '现场','演唱会','卡拉OK','KTV','纯音乐','演奏','二胡','古筝','钢琴','小提琴',
                '大提琴','吉他','萨克斯','笛子','洞箫','古琴','琵琶','扬琴','唢呐','马头琴',
                '童声','合唱','插曲','主题曲','片头曲','片尾曲','DSD','HQCD']
            if not any(kw in content for kw in version_kw) and len(content) <= 15:
                artist = content
                clean_title = (clean_title[:m.start()] + clean_title[m.end():]).strip(' -_·')
    # 清理歌名末尾的括号歌手
    clean_title = re.sub(r'\s*[（(][^）)]*[）)]\s*$', '', clean_title).strip(' -_·')
    if not clean_title:
        clean_title = title
    # 规范化风格
    style_map = {'Other': '流行', 'Unknown': '流行', '未知': '流行', 'Pop': '流行',
                 'Classical': '古典', 'National Folk': '民族', 'POP': '流行',
                 'Pop－Folk': '民谣', 'Pop-Folk': '民谣'}
    if style in style_map:
        style = style_map[style]
    # 推断专辑名
    album = infer_album_from_dir(fp)
    # 临时文件
    tmp = fp + '.tmp.flac'
    cmd = [FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-i', fp,
           '-map', '0:a', '-c:a', 'copy',
           '-metadata', 'TITLE=' + clean_title,
           '-metadata', 'ARTIST=' + artist,
           '-metadata', 'GENRE=' + style,
           '-metadata', 'LANGUAGE=' + lang]
    if album:
        cmd += ['-metadata', 'ALBUM=' + album]
    cmd.append(tmp)
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=30)
        if p.returncode != 0 or not os.path.exists(tmp) or os.path.getsize(tmp) == 0:
            return False, 'ffmpeg fail'
        os.replace(tmp, fp)
        return True, artist + ' - ' + clean_title
    except Exception as e:
        if os.path.exists(tmp):
            try: os.remove(tmp)
            except: pass
        return False, str(e)[:80]

def main():
    files = []
    print('扫描文件...')
    for dp, dns, fns in os.walk(OUT):
        for fn in fns:
            if fn.endswith('.flac'):
                files.append(os.path.join(dp, fn))
    print('共 ' + str(len(files)) + ' 个文件')
    t0 = time.time()
    fixed = 0
    failed = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(fix_metadata, fp): fp for fp in files}
        for i, fu in enumerate(as_completed(futs), 1):
            fp = futs[fu]
            try:
                ok, msg = fu.result()
                if ok:
                    fixed += 1
                else:
                    failed += 1
            except Exception as e:
                failed += 1
            if i % 500 == 0:
                print('进度 %d/%d 已修复=%d 失败=%d 用时%.0fs' % (i, len(files), fixed, failed, time.time()-t0))
    print('完成: 已修复=%d 失败=%d 总用时%.1f分钟' % (fixed, failed, (time.time()-t0)/60))

if __name__ == '__main__':
    main()
