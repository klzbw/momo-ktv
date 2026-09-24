# SPDX-FileCopyrightText: Copyright (C) 2024-2025 沉默の金 <cmzj@cmzj.org>
# SPDX-License-Identifier: GPL-3.0-only
"""服务端桩：SRT 解析器，云端歌词获取不需要。"""


def srt2mdata(*_args, **_kwargs):  # noqa: ANN001
    raise NotImplementedError("SRT parser not available in server build")
