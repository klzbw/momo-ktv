# SPDX-FileCopyrightText: Copyright (C) 2024-2025 沉默の金 <cmzj@cmzj.org>
# SPDX-License-Identifier: GPL-3.0-only
"""服务端精简版 args：无 Qt、无命令行解析。"""

from types import SimpleNamespace

running_lddc = True

args = SimpleNamespace(
    debug=False,
    log_level="INFO",
    get_service_port=None,
)
