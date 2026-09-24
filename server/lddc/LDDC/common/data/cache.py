# SPDX-FileCopyrightText: Copyright (C) 2024-2025 沉默の金 <cmzj@cmzj.org>
# SPDX-License-Identifier: GPL-3.0-only
"""服务端精简版缓存：内存字典，无 diskcache / 无持久化。

提供：
- cached_call_with_status: 直接调用函数，不缓存
- cache: 内存缓存对象，兼容 .get/.set/__contains__/.memoize() 用法
"""

from collections.abc import Callable
from typing import Any, ParamSpec, TypeVar

P = ParamSpec("P")
T = TypeVar("T")


class _MemoryCache:
    """极简内存缓存，兼容 diskcache.Cache 的 .get/.set/.memoize 接口子集。"""

    def __init__(self) -> None:
        self._store: dict[Any, Any] = {}
        self._memo: dict[Any, Any] = {}

    def get(self, key: Any, default: Any = None) -> Any:
        return self._store.get(key, default)

    def set(self, key: Any, value: Any, expire: int | None = None) -> None:
        self._store[key] = value

    def __contains__(self, key: Any) -> bool:
        return key in self._store

    def expire(self) -> None:  # noqa: D401 - 兼容接口
        return None

    def close(self) -> None:  # noqa: D401 - 兼容接口
        return None

    def memoize(self, *args: Any, **kwargs: Any) -> Callable[..., Any]:
        """装饰器工厂：与 diskcache.Cache.memoize() 兼容（此处不做 TTL）。"""

        def decorator(func: Callable[P, T]) -> Callable[P, T]:
            def wrapper(*f_args: P.args, **f_kwargs: P.kwargs) -> T:
                key = (func.__module__, func.__qualname__, f_args, tuple(sorted(f_kwargs.items())))
                if key not in self._memo:
                    self._memo[key] = func(*f_args, **f_kwargs)
                return self._memo[key]

            return wrapper

        return decorator


cache = _MemoryCache()


def cached_call_with_status(
    func: Callable[P, T],
    cache_settings: dict | None = None,
    *args: P.args,
    **kwargs: P.kwargs,
) -> tuple[T, bool]:
    """直接调用，不缓存，返回 (result, False)。"""
    return func(*args, **kwargs), False
