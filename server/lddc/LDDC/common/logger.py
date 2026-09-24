# SPDX-FileCopyrightText: Copyright (C) 2024-2025 沉默の金 <cmzj@cmzj.org>
# SPDX-License-Identifier: GPL-3.0-only
"""服务端精简版日志：stdlib logging，输出到 stdout。"""

import logging
import sys

_FORMAT = "[%(levelname)s]%(asctime)s- %(module)s(%(lineno)d) - %(funcName)s:%(message)s"


class _Logger:
    """对外暴露 debug/info/warning/error/exception/log 方法。"""

    def __init__(self, name: str = "LDDC", level: int = logging.INFO) -> None:
        self._logger = logging.getLogger(name)
        self._logger.setLevel(level)
        self._logger.propagate = False
        if not self._logger.handlers:
            handler = logging.StreamHandler(sys.stdout)
            handler.setFormatter(logging.Formatter(_FORMAT))
            self._logger.addHandler(handler)

    def set_level(self, level: int | str) -> None:
        if isinstance(level, str):
            level = logging.getLevelName(level.upper())
        self._logger.setLevel(level)
        for h in self._logger.handlers:
            h.setLevel(level)

    def debug(self, *args: object, **kwargs: object) -> None:
        self._logger.debug(*args, **kwargs)

    def info(self, *args: object, **kwargs: object) -> None:
        self._logger.info(*args, **kwargs)

    def warning(self, *args: object, **kwargs: object) -> None:
        self._logger.warning(*args, **kwargs)

    def error(self, *args: object, **kwargs: object) -> None:
        self._logger.error(*args, **kwargs)

    def critical(self, *args: object, **kwargs: object) -> None:
        self._logger.critical(*args, **kwargs)

    def exception(self, *args: object, **kwargs: object) -> None:
        self._logger.exception(*args, **kwargs)

    def log(self, *args: object, **kwargs: object) -> None:
        self._logger.log(*args, **kwargs)


logger = _Logger()
