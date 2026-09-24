# SPDX-FileCopyrightText: Copyright (C) 2024-2025 沉默の金 <cmzj@cmzj.org>
# SPDX-License-Identifier: GPL-3.0-only
"""LDDC的歌词提供api（服务端精简版）

仅保留 LyricsAPI 类与 lyrics_api 实例，去掉模块级缓存函数与本地歌词源。
"""

from collections.abc import Callable
from pathlib import Path
from threading import Lock
from typing import TYPE_CHECKING, Literal, NoReturn, overload

from LDDC.common.exceptions import LDDCError, LyricsNotFoundError
from LDDC.common.logger import logger
from LDDC.common.models import APIResultList, LyricInfo, Lyrics, P, SearchType, SongInfo, SongListInfo, Source, T

if TYPE_CHECKING:
    from .models import BaseAPI, CloudAPI


class LyricsAPI:
    def __init__(self) -> None:
        self.init_lock = Lock()
        self.inited = False

    def init(self) -> None:
        with self.init_lock:
            if self.inited:
                return
            from .kg import KGAPI
            from .lrclib import LrclibAPI
            from .ne import NEAPI
            from .qm import QMAPI

            self.cloud_apis: dict[Source, CloudAPI] = {
                KGAPI.source: KGAPI(),
                NEAPI.source: NEAPI(),
                QMAPI.source: QMAPI(),
                LrclibAPI.source: LrclibAPI(),  # 添加LrclibAPI到cloud_apis字典中
            }
            self.apis: dict[Source, BaseAPI] = dict(self.cloud_apis)
            self.inited = True

    def timeout_retry(self, func: Callable[P, T], *args: P.args, **kwargs: P.kwargs) -> T:
        from httpx import TimeoutException  # 加快启动速度

        for i in range(3):
            try:
                return func(*args, **kwargs)
            except TimeoutException:  # noqa: PERF203
                if i == 2:
                    raise
                continue
            except Exception:
                logger.exception("请求歌词Api时遇到错误")
                raise

        msg = "Unknown error"
        raise LDDCError(msg)

    @overload
    def search(self, source: Source, keyword: str, search_type: Literal[SearchType.SONG], page: int = 1) -> APIResultList[SongInfo]: ...

    @overload
    def search(
        self,
        source: Source,
        keyword: str,
        search_type: Literal[SearchType.SONGLIST, SearchType.ALBUM],
        page: int = 1,
    ) -> APIResultList[SongListInfo]: ...

    @overload
    def search(
        self,
        source: Source,
        keyword: str,
        search_type: Literal[SearchType.SONG, SearchType.SONGLIST, SearchType.ALBUM],
        page: int = 1,
    ) -> APIResultList[SongInfo] | APIResultList[SongListInfo]: ...

    @overload
    def search(
        self,
        source: Source,
        keyword: str,
        search_type: SearchType,
        page: int = 1,
    ) -> APIResultList[SongInfo] | APIResultList[SongListInfo]: ...

    @overload
    def search(
        self,
        source: Source,
        keyword: str,
        search_type: Literal[SearchType.ARTIST, SearchType.LYRICS],
        page: int = 1,
    ) -> NoReturn: ...

    def search(self, source: Source, keyword: str, search_type: SearchType, page: int = 1) -> APIResultList[SongInfo] | APIResultList[SongListInfo]:
        """从指定歌词源搜索歌曲/专辑/歌单"""
        if not self.inited:
            self.init()
        if source not in self.cloud_apis:
            msg = f"Unsupported source: {source}"
            raise ValueError(msg)
        if search_type not in self.cloud_apis[source].supported_search_types:
            msg = f"Unsupported search type: {search_type}"
            raise ValueError(msg)
        return self.timeout_retry(self.cloud_apis[source].search, keyword, search_type, page)

    def get_songlist(self, songlist_info: SongListInfo) -> APIResultList[SongInfo]:
        if not self.inited:
            self.init()
        return self.timeout_retry(self.cloud_apis[songlist_info.source].get_songlist, songlist_info)

    def get_lyricslist(self, song_info: SongInfo) -> APIResultList[LyricInfo]:
        if not self.inited:
            self.init()
        return self.timeout_retry(self.cloud_apis[song_info.source].get_lyricslist, song_info)

    def get_lyrics(self, info: SongInfo | LyricInfo | None = None, path: Path | None = None, data: str | bytearray | bytes | None = None) -> Lyrics:
        """获取歌词（服务端仅支持云源）"""
        if not self.inited:
            self.init()
        if not info or info.source == Source.Local:
            msg = "服务端不支持本地歌词源"
            raise LyricsNotFoundError(msg, info)
        lyrics = self.timeout_retry(self.apis[info.source].get_lyrics, info)
        if not lyrics:
            msg = "没有找到歌词"
            raise LyricsNotFoundError(msg, info)
        return lyrics


lyrics_api = LyricsAPI()
