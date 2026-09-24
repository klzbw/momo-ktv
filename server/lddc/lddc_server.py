# SPDX-FileCopyrightText: Copyright (C) 2024-2025 沉默の金 <cmzj@cmzj.org>
# SPDX-License-Identifier: GPL-3.0-only
"""LDDC 轻量歌词 HTTP 服务（零额外依赖，仅标准库）。"""

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from LDDC.common.models import LyricsFormat, LyricsType, SearchType, Source  # noqa: E402
from LDDC.core.algorithm import calculate_artist_score, calculate_title_score  # noqa: E402
from LDDC.core.api.lyrics import lyrics_api  # noqa: E402

HOST = "127.0.0.1"
PORT = 8766

# 搜索顺序与源名映射
SOURCE_ORDER = [Source.QM, Source.KG, Source.NE]
SOURCE_NAME = {
    Source.QM: "qq",
    Source.KG: "kugou",
    Source.NE: "netease",
}

MIN_SCORE = 55
DURATION_TOLERANCE_MS = 4000


def _json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _search_lyrics(title: str, artist: str, duration: int | None) -> dict:
    keyword = f"{artist} - {title}" if artist else title

    best_song = None
    best_score = -1.0
    best_source = None

    for source in SOURCE_ORDER:
        try:
            results = lyrics_api.search(source, keyword, SearchType.SONG, 1)
        except Exception:
            # 单个源失败，继续下一个
            continue

        for song in results:
            # 时长过滤（song.duration 单位毫秒）
            if duration is not None and song.duration is not None:
                if abs(song.duration - duration * 1000) > DURATION_TOLERANCE_MS:
                    continue

            title_score = calculate_title_score(title, song.title or "")
            artist_score = calculate_artist_score(artist or "", str(song.artist) if song.artist else "")
            total = title_score * 0.6 + artist_score * 0.4

            if total > best_score:
                best_score = total
                best_song = song
                best_source = source

    if best_song is None or best_score < MIN_SCORE:
        return {"found": False, "error": "not_found"}

    # 获取歌词
    try:
        lyrics = lyrics_api.get_lyrics(best_song)
    except Exception:
        return {"found": False, "error": "not_found"}

    if not lyrics:
        return {"found": False, "error": "not_found"}

    # 选择输出格式
    if lyrics.types.get("orig") == LyricsType.VERBATIM:
        out_format = LyricsFormat.ENHANCEDLRC
        lrc_type = "verbatim"
    else:
        out_format = LyricsFormat.LINEBYLINELRC
        lrc_type = "linebyline"

    lrc = lyrics.to(out_format, ["orig"])

    return {
        "found": True,
        "lrc": lrc,
        "source": SOURCE_NAME.get(best_source, "unknown"),
        "score": int(round(best_score)),
        "type": lrc_type,
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: object) -> None:  # noqa: A003
        # 静默默认访问日志
        return

    def do_GET(self) -> None:  # noqa: N802
        try:
            if self.path == "/health":
                _json_response(self, 200, {"status": "ok"})
            else:
                _json_response(self, 404, {"found": False, "error": "not_found"})
        except Exception as e:  # noqa: BLE001
            _json_response(self, 500, {"found": False, "error": str(e)})

    def do_POST(self) -> None:  # noqa: N802
        try:
            if self.path != "/lddc/lyrics":
                _json_response(self, 404, {"found": False, "error": "not_found"})
                return

            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length else b"{}"
            try:
                body = json.loads(raw.decode("utf-8")) if raw else {}
            except json.JSONDecodeError:
                _json_response(self, 400, {"found": False, "error": "invalid_json"})
                return

            title = body.get("title", "") or ""
            artist = body.get("artist", "") or ""
            duration = body.get("duration")
            if duration is not None:
                try:
                    duration = int(duration)
                except (TypeError, ValueError):
                    duration = None

            result = _search_lyrics(title, artist, duration)
            _json_response(self, 200, result)
        except Exception as e:  # noqa: BLE001
            _json_response(self, 500, {"found": False, "error": str(e)})


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[LDDC] server started on {HOST}:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
