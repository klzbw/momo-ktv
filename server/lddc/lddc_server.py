# SPDX-FileCopyrightText: Copyright (C) 2024-2025 沉默の金 <cmzj@cmzj.org>
# SPDX-License-Identifier: GPL-3.0-only
"""
LDDC 逐字歌词 HTTP 服务（momo-ktv 服务端）
监听 127.0.0.1:8766，提供多源歌词搜索与增强型 LRC 输出。
"""

import json
import os
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from LDDC.common.logger import logger  # noqa: E402
from LDDC.common.models import LyricsType, SearchType, Source  # noqa: E402
from LDDC.common.time import ms2roundedtime  # noqa: E402
from LDDC.core.algorithm import calculate_artist_score, calculate_title_score  # noqa: E402
from LDDC.core.api.lyrics import get_lyrics, search  # noqa: E402

HOST = "127.0.0.1"
PORT = 8766
MATCH_THRESHOLD = 55
SEARCH_SOURCES = [Source.QM, Source.KG, Source.NE]

SOURCE_NAME = {
    Source.QM: "qq",
    Source.KG: "kugou",
    Source.NE: "netease",
    Source.LRCLIB: "lrclib",
}


def format_time(ms: int) -> str:
    """毫秒 -> mm:ss.xx（两位厘秒，与前端解析器一致）"""
    return ms2roundedtime(ms)


def lyrics_to_enhanced_lrc(fslyrics) -> str:
    """将 FSLyrics 转换为增强型 LRC 字符串。

    格式: [mm:ss.xx]<mm:ss.xx>字<mm:ss.xx>字...
    """
    lines_out: list[str] = []
    orig = fslyrics.get("orig")
    if not orig:
        return ""

    for line in orig:
        line_start = line.start if line.start is not None else 0
        parts = [f"[{format_time(line_start)}]"]
        for word in line.words:
            if word.start is not None:
                parts.append(f"<{format_time(word.start)}>")
            parts.append(word.text)
        lines_out.append("".join(parts))

    return "\n".join(lines_out)


def score_result(req_title: str, req_artist: str, req_duration_ms: int | None, song) -> float:
    """计算单条搜索结果的匹配分（0-100）"""
    title_s = calculate_title_score(req_title or "", song.title or "")
    artist_s = calculate_artist_score(req_artist or "", song.str_artist or "")
    total = title_s * 0.6 + artist_s * 0.4
    if req_duration_ms and song.duration:
        diff = abs(req_duration_ms - song.duration)
        if diff < 4000:
            total = min(100.0, total + 10)
    return total


def find_best_lyrics(title: str, artist: str, duration_sec: int | None):
    """顺序搜索 QM/KG/NE，返回 (SongInfo, score, source_name) 或 None"""
    keyword = f"{artist} {title}".strip()
    req_duration_ms = duration_sec * 1000 if duration_sec else None

    best_song = None
    best_score = 0.0
    best_source = None

    for src in SEARCH_SOURCES:
        try:
            results = search(source=src, keyword=keyword, search_type=SearchType.SONG, page=1)
        except Exception:
            logger.warning(f"搜索 {src} 失败，跳过")
            continue

        for song in results:
            try:
                s = score_result(title, artist, req_duration_ms, song)
            except Exception:
                continue
            if s > best_score:
                best_score = s
                best_song = song
                best_source = src

    if best_song is None or best_score < MATCH_THRESHOLD:
        return None

    return best_song, best_score, SOURCE_NAME.get(best_source, "unknown")


class LDDCHandler(BaseHTTPRequestHandler):
    def _send_json(self, obj: dict, status: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send_json({"status": "ok"})
        else:
            self._send_json({"error": "not_found"}, status=404)

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/lddc/lyrics":
            self._send_json({"found": False, "error": "not_found"}, status=404)
            return

        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length) if length else b"{}"
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            self._send_json({"found": False, "error": "bad_request"}, status=400)
            return

        title = (body.get("title") or "").strip()
        artist = (body.get("artist") or "").strip()
        duration = body.get("duration")

        if not title:
            self._send_json({"found": False, "error": "missing_title"}, status=400)
            return

        try:
            result = find_best_lyrics(title, artist, duration)
            if result is None:
                self._send_json({"found": False, "error": "not_found"})
                return

            song, score, src_name = result
            lyrics = get_lyrics(song)

            orig_type = lyrics.types.get("orig", LyricsType.PlainText)
            lrc_type = "verbatim" if orig_type == LyricsType.VERBATIM else "lrc"

            duration_ms = int(duration * 1000) if duration else None
            fslyrics = lyrics.get_fslyrics(duration_ms)
            lrc_text = lyrics_to_enhanced_lrc(fslyrics)

            if not lrc_text:
                self._send_json({"found": False, "error": "not_found"})
                return

            self._send_json({
                "found": True,
                "lrc": lrc_text,
                "source": src_name,
                "score": round(score),
                "type": lrc_type,
            })

        except Exception:
            logger.error("处理歌词请求异常:\n" + traceback.format_exc())
            self._send_json({"found": False, "error": "internal_error"}, status=500)

    def log_message(self, fmt, *args):  # noqa: A003
        logger.info("%s - %s", self.address_string(), fmt % args)


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), LDDCHandler)
    logger.info(f"LDDC lyrics server listening on http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("shutting down")
        server.server_close()


if __name__ == "__main__":
    main()
