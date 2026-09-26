"""Bounded Discord retries and per-client rate limits over Workers Fetch."""

import asyncio
import math
import time
from dataclasses import dataclass, field
from urllib.parse import urlsplit


class DiscordRateLimitError(RuntimeError):
    pass


@dataclass
class Bucket:
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    until: float = 0


def route_key(url, method):
    parts = urlsplit(url).path.removeprefix("/api/v10").split("/")
    major = tuple(parts[1:3]) if len(parts) > 2 and parts[1] in {"channels", "guilds"} else ()
    if len(parts) > 3 and parts[1] == "webhooks":
        major = tuple(parts[1:4])
    normalized = [":id" if part.isdecimal() else part for part in parts]
    if len(parts) > 3 and parts[1] == "webhooks":
        normalized[3] = ":token"
    return (method, "/".join(normalized)), major


def seconds(value):
    try:
        number = float(value)
        return number if math.isfinite(number) and number >= 0 else None
    except TypeError, ValueError:
        return None


def header(response, name):
    headers = getattr(response, "headers", {})
    return headers.get(name) or headers.get(name.lower())


class DiscordHTTP:
    """Hints are local to this client; 429s remain authoritative across isolates.

    Retry rejected requests, but never replay an ambiguous POST on network/5xx
    failure (it could duplicate a Discord message or create a second thread).
    """

    def __init__(self, *, clock=time.monotonic, sleep=asyncio.sleep):
        self.clock, self.sleep = clock, sleep
        self.routes: dict[tuple, Bucket] = {}
        self.buckets: dict[tuple, Bucket] = {}
        self.global_until: dict[str, float] = {}

    def prune(self):
        for table in (self.routes, self.buckets):
            if len(table) >= 256:
                for key, bucket in list(table.items()):
                    if not bucket.lock.locked() and bucket.until <= self.clock():
                        del table[key]

    async def send(self, transport, url, **options):
        async with asyncio.timeout(25):
            return await self._send(transport, url, options)

    async def _send(self, transport, url, options):
        method = options.get("method", "GET").upper()
        auth = "bot" if options.get("headers", {}).get("authorization") else "anonymous"
        route, major = route_key(url, method)
        key = (auth, route, major)
        self.prune()
        state = self.routes.setdefault(key, Bucket())
        deadline = self.clock() + 25
        safe_retry = method in {"GET", "HEAD", "PUT", "DELETE", "PATCH"}
        for attempt in range(4):
            # A learned bucket can be shared by several previously separate routes.
            state = self.routes.get(key, state)
            async with state.lock:
                if self.routes.get(key, state) is not state:
                    continue
                while True:
                    delay = max(state.until, self.global_until.get(auth, 0)) - self.clock()
                    if delay <= 0:
                        break
                    if self.clock() + delay >= deadline:
                        raise DiscordRateLimitError("Discord retry exceeds request budget")
                    await self.sleep(delay)
                remaining = deadline - self.clock()
                if remaining <= 0:
                    raise DiscordRateLimitError("Discord request budget exhausted")
                try:
                    response = await transport(
                        url, **options, timeout_ms=max(1, min(15000, int(remaining * 1000)))
                    )
                except Exception:
                    if not safe_retry or attempt == 3:
                        raise
                    state.until = max(state.until, self.clock() + 0.5 * 2**attempt)
                    continue
                bucket_hash = header(response, "X-RateLimit-Bucket")
                if bucket_hash:
                    canonical = self.buckets.setdefault((auth, bucket_hash, major), state)
                    canonical.until = max(canonical.until, state.until)
                    self.routes[key] = canonical
                else:
                    canonical = state
                reset = seconds(header(response, "X-RateLimit-Reset-After"))
                if header(response, "X-RateLimit-Remaining") == "0" and reset is not None:
                    canonical.until = max(canonical.until, self.clock() + reset)
                if response.status == 429:
                    try:
                        body = await response.json()
                    except Exception:
                        body = {}
                    body = body if isinstance(body, dict) else {}
                    retry = seconds(body.get("retry_after"))
                    if retry is None:
                        retry = seconds(header(response, "Retry-After"))
                    # A malformed limit response must never trigger immediate retries.
                    if retry is None:
                        return response
                    until = self.clock() + max(retry, 0.05)
                    canonical.until = max(canonical.until, until)
                    if (
                        body.get("global") is True
                        or header(response, "X-RateLimit-Global") == "true"
                    ):
                        self.global_until[auth] = max(self.global_until.get(auth, 0), until)
                    if attempt == 3:
                        return response
                elif response.status in {500, 502, 503, 504} and safe_retry and attempt < 3:
                    canonical.until = max(canonical.until, self.clock() + 0.5 * 2**attempt)
                else:
                    return response
        raise DiscordRateLimitError("Discord retry budget exhausted")
