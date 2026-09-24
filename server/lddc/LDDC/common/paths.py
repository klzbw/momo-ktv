# SPDX-FileCopyrightText: Copyright (C) 2024-2025 沉默の金 <cmzj@cmzj.org>
# SPDX-License-Identifier: GPL-3.0-only
"""服务端精简版路径：使用临时目录，无 Qt 标准路径。"""

import tempfile
from pathlib import Path

_base = Path(tempfile.gettempdir()) / "LDDC_server"
config_dir = _base / "config"
data_dir = _base / "data"
cache_dir = _base / "cache"
log_dir = _base / "logs"
default_save_lyrics_dir = _base / "lyrics"
auto_save_dir = data_dir / "auto_save"

for d in (config_dir, data_dir, cache_dir, log_dir, auto_save_dir):
    d.mkdir(parents=True, exist_ok=True)

__all__ = [
    "auto_save_dir",
    "cache_dir",
    "config_dir",
    "data_dir",
    "default_save_lyrics_dir",
    "log_dir",
]
