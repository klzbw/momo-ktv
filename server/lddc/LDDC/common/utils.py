# SPDX-FileCopyrightText: Copyright (C) 2024-2025 沉默の金 <cmzj@cmzj.org>
# SPDX-License-Identifier: GPL-3.0-only
"""精简版 common.utils（无 Qt / 无 path_processor 依赖）

服务端仅需要 has_content 与 LimitedSizeDict。
"""
import re
from collections import OrderedDict
from typing import Any


class LimitedSizeDict(OrderedDict):
    def __init__(self, max_size: int, *args: Any, **kwargs: Any) -> None:
        self.max_size = max_size
        super().__init__(*args, **kwargs)

    def __setitem__(self, key: Any, value: Any) -> None:
        if len(self) >= self.max_size:
            self.popitem(last=False)  # 删除最早插入的项目
        super().__setitem__(key, value)


def has_content(line: str) -> bool:
    """检查是否有实际内容"""
    content = re.sub(r"\[\d+:\d+\.\d+\]|\[\d+,\d+\]|<\d+:\d+\.\d+>", "", line).strip()
    if content in ("", "//"):
        return False
    return not (len(content) == 2 and content[0].isupper() and content[1] == "：")  # 歌手标签行
