# SPDX-FileCopyrightText: Copyright (C) 2024-2025 沉默の金 <cmzj@cmzj.org>
# SPDX-License-Identifier: GPL-3.0-only
"""服务端精简版日志：纯标准库 logging，输出到 stdout，不写文件。"""

import logging
import sys

from .data.config import cfg

LEVEL_MAP = {
    "NOTSET": logging.NOTSET,
    "DEBUG": logging.DEBUG,
    "INFO": logging.INFO,
    "WARNING": logging.WARNING,
    "ERROR": logging.ERROR,
    "CRITICAL": logging.CRITICAL,
}


class _StdoutLogger:
    """轻量日志器，替代原 Qt 版本。"""

    def __init__(self) -> None:
        self._logger = logging.getLogger("LDDC")
        self._logger.setLevel(LEVEL_MAP.get(cfg.get("log_level", "INFO"), logging.INFO))
        self._logger.propagate = False
        if not self._logger.handlers:
            handler = logging.StreamHandler(sys.stdout)
            handler.setFormatter(
                logging.Formatter("[%(levelname)s]%(asctime)s - %(module)s(%(lineno)d) - %(funcName)s: %(message)s"),
            )
            self._logger.addHandler(handler)

    def set_level(self, level: str | int) -> None:
        if isinstance(level, str):
            level = LEVEL_MAP.get(level, logging.INFO)
        self._logger.setLevel(level)
        for h in self._logger.handlers:
            h.setLevel(level)

    def debug(self, *a, **kw):  # noqa: ANN001
        self._logger.debug(*a, **kw)

    def info(self, *a, **kw):  # noqa: ANN001
        self._logger.info(*a, **kw)

    def warning(self, *a, **kw):  # noqa: ANN001
        self._logger.warning(*a, **kw)

    def error(self, *a, **kw):  # noqa: ANN001
        self._logger.error(*a, **kw)

    def critical(self, *a, **kw):  # noqa: ANN001
        self._logger.critical(*a, **kw)

    def exception(self, *a, **kw):  # noqa: ANN001
        self._logger.exception(*a, **kw)

    def log(self, *a, **kw):  # noqa: ANN001
        self._logger.log(*a, **kw)


logger = _StdoutLogger()
