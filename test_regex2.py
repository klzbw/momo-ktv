# -*- coding: utf-8 -*-
import re
_META_LINE = re.compile(
    r'^\s*(词|曲|作词|作曲|词曲|编曲|制作人|制片人|监制|和声|和音|混音|母带|录音|录音师|录音棚|'
    r'吉他|贝斯|鼓|键盘|弦乐|钢琴|编曲人|原唱|封面|设计|发行|出品|出品人|OP|SP|ISRC|'
    r'专辑|歌手|歌名|标题|制作|编写|歌词|program|Program|PROGRAM|竹笛|电贝斯|合声|制作统筹|发行人|母带处理|出品公司|发行公司|OP|SP)[^\s：:][^：:]*[:：]')

test_lines = [
    '词Lyrics by：刀郎',
    '曲Composed by：刀郎',
    '编曲Music Arranged by：刀郎',
    '制作人Producer：刀郎',
    '制作统筹Musical Co-ordination：张旖旎Judy',
    '录音Recorded by：刀郎',
    '竹笛Bamboo Flute：刀郎',
    '电贝斯Bass：李军',
    '合声Backing Vocal：刀郎',
    '录音室Recording Studio：Soundquake Studio',
    'OP：刀郎',
    'SP：旭润音乐',
    '发行人Publisher：赵旭',
    '昨日犹似羽衣舞 今朝北邙狐兔窟',
    '当天空依旧愁云山雨欲来',
    '岩洞里阴冷潮湿没有火的照应',
]
print("=== 正则测试 ===")
for line in test_lines:
    matched = bool(_META_LINE.match(line))
    status = '过滤' if matched else '保留'
    print(f"  {status}: {line}")
