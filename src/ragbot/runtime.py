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
    from js import AbortSignal, Request
    from workers import fetch as worker_fetch

    # Serialize FormData once before Fetch/observability can clone the request.
    # Re-encoding FormData with a copied Content-Type changes the boundary and
    # produces a body Discord cannot parse.
    body = options.get("body")
    if getattr(getattr(body, "constructor", None), "name", None) == "FormData":
        request = Request.new(url, to_js(options))
        options["body"] = await request.arrayBuffer()
        options["headers"] = {
            **options.get("headers", {}),
            "content-type": request.headers.get("content-type"),
        }
    options["signal"] = AbortSignal.timeout(timeout_ms)
    return await worker_fetch(url, **options)


def wait_until(ctx: Any, awaitable: Any) -> None:
    """Retain the Python task's JS proxy until background work settles."""
    import asyncio
    import sys

    task = asyncio.ensure_future(awaitable)
    if sys.platform != "emscripten":
        # Local behavior tests use a Python context with no JavaScript boundary.
        ctx.waitUntil(task)
        return
    from pyodide.ffi import create_proxy

    proxy = create_proxy(task)
    task.add_done_callback(lambda finished: proxy.destroy())
    ctx.waitUntil(proxy)
