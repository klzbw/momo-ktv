# -*- coding: utf-8 -*-
import urllib.request, urllib.parse, json

# 搜索专辑
keyword = urllib.parse.quote('音乐殿堂 长笛名曲集')
url = f'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w={keyword}&format=json&p=1&n=5'
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
resp = urllib.request.urlopen(req, timeout=10)
data = json.loads(resp.read().decode('utf-8'))
albums = data.get('data', {}).get('album', {}).get('list', [])
print('搜索到' + str(len(albums)) + '张专辑:')
for a in albums:
    aid = a.get('albumID')
    name = a.get('albumName', '')
    cnt = a.get('songCount', 0)
    print(str(aid) + ' - ' + name + ' (' + str(cnt) + '首)')
    # 获取第一张专辑的曲目
    if aid:
        url2 = f'https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg?albumid={aid}&format=json'
        req2 = urllib.request.Request(url2, headers={'User-Agent': 'Mozilla/5.0'})
        resp2 = urllib.request.urlopen(req2, timeout=10)
        data2 = json.loads(resp2.read().decode('utf-8'))
        songs = data2.get('data', {}).get('list', [])
        print('  曲目:')
        for i, s in enumerate(songs, 1):
            print('  ' + str(i) + '. ' + s.get('songname', ''))
