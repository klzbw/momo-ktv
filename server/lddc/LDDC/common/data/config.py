# SPDX-FileCopyrightText: Copyright (C) 2024-2025 沉默の金 <cmzj@cmzj.org>
# SPDX-License-Identifier: GPL-3.0-only
"""服务端精简版配置：纯 dict，无 Qt / 无文件读写。"""

from typing import Any


class Config(dict):
    """LDDC 服务端配置（无 Qt 信号、无持久化）"""

    def __init__(self) -> None:
        super().__init__()
        self.default_cfg = {
            "multi_search_sources": ["QM", "KG", "NE"],
            "langs_order": ["roma", "orig", "ts"],
            "add_end_timestamp_line": False,
            "lrc_ms_digit_count": 3,
            "last_ref_line_time_sty": 0,  # 0: 与当前原文起始时间相同 1: 与下一行原文起始时间接近
            "log_level": "INFO",
        }
        for key, value in self.default_cfg.items():
            self[key] = value


cfg = Config()
