"""Keep the Pyodide boundary small; application services use Python values."""

from typing import Any


def to_js(value: Any) -> Any:
    from js import Object
    from pyodide.ffi import to_js as convert

    return convert(value, dict_converter=Object.fromEntries)


def to_python(value: Any) -> Any:
    return value.to_py() if hasattr(value, "to_py") else value


def env_value(env: Any, name: str, default: Any = None) -> Any:
    value = getattr(env, name, None)
    return default if value is None else value


async def fetch(url: str, *, timeout_ms: int = 15000, **options: Any) -> Any:
    from js import AbortSignal
    from workers import fetch as worker_fetch

    options["signal"] = AbortSignal.timeout(timeout_ms)
    return await worker_fetch(url, **options)
