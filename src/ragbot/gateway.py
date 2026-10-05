"""Discord gateway lifecycle, owned by one Durable Object."""

import asyncio
import json
import logging
import random
import time
from collections import OrderedDict
from typing import Any
from urllib.parse import urlparse

from .runtime import wait_until

log = logging.getLogger("ragbot")
GATEWAY_NAME = "discord-gateway-v2"
DEFAULT_GATEWAY_URL = "wss://gateway.discord.gg"
FATAL_CLOSE_CODES = frozenset({4004, 4010, 4011, 4012, 4013, 4014})
NON_RESUMABLE_CLOSE_CODES = frozenset({4003, 4007, 4009})
MAX_RECONNECT_DELAY = 300
WATCHDOG_MS = 60_000
SWEEP_INTERVAL_MS = 3_600_000
MARKER_TTL_MS = 86_400_000
STORAGE_DELETE_LIMIT = 128


def gateway_stub(env):
    return env.DISCORD_GATEWAY.get(env.DISCORD_GATEWAY.idFromName(GATEWAY_NAME))


def gateway_url(url):
    """IDENTIFY and RESUME carry the bot token; only connect to Discord gateway hosts."""
    parsed = urlparse(url)
    if parsed.scheme == "wss" and (parsed.hostname or "").endswith(".discord.gg"):
        return url.rstrip("/")
    return DEFAULT_GATEWAY_URL


def now_ms():
    return round(time.time() * 1000)


class Socket:
    """Own callback proxies for exactly one Workers WebSocket."""

    def __init__(self, url, on_message, on_close, on_error):
        from js import WebSocket
        from pyodide.ffi import create_proxy

        self.raw = WebSocket.new(url)
        self.listeners = {
            "message": create_proxy(lambda event: on_message(event.data)),
            "close": create_proxy(lambda event: on_close(event.code)),
            "error": create_proxy(lambda event: on_error()),
        }
        for name, callback in self.listeners.items():
            self.raw.addEventListener(name, callback)

    @property
    def ready_state(self):
        return self.raw.readyState

    def send(self, text):
        self.raw.send(text)

    def close(self, code, reason):
        self.dispose()
        if self.ready_state in (0, 1):
            self.raw.close(code, reason)

    def dispose(self):
        for name, callback in self.listeners.items():
            self.raw.removeEventListener(name, callback)
            callback.destroy()
        self.listeners.clear()


class Gateway:
    def __init__(self, ctx, env, app, *, socket_factory=Socket):
        self.ctx, self.env, self.app = ctx, env, app
        self.socket_factory = socket_factory
        self.socket: Any = None
        self.heartbeat_timer = None
        self.reconnect_timer = None
        self.sequence = self.session_id = self.resume_url = self.bot_user_id = None
        self.saved_sequence = None
        self.heartbeat_acknowledged = True
        self.attempts = 0
        self.identify_after = 0.0
        self.swept_at = 0
        self.processed: OrderedDict[str, None] = OrderedDict()
        self.tasks: set[asyncio.Task] = set()
        self.initialized = False
        self.lock = asyncio.Lock()
        self.connecting = asyncio.Lock()
        self.enabled = False

    def background(self, coroutine):
        async def contained():
            try:
                await coroutine
            except Exception:
                log.error("gateway_background_failed")

        task = asyncio.create_task(contained())
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        wait_until(self.ctx, task)

    def canonical(self):
        return self.ctx.id.equals(self.env.DISCORD_GATEWAY.idFromName(GATEWAY_NAME))

    async def initialize(self):
        async with self.lock:
            if self.initialized:
                return
            if not self.canonical():
                await self.ctx.storage.deleteAlarm()
                await self.ctx.storage.deleteAll()
                log.warning("gateway_stale_instance_decommissioned")
            else:
                # A restarted object resumes the stored session; Discord replays missed events.
                session = await self.ctx.storage.get("gatewaySession")
                if session:
                    self.session_id = session["sessionId"]
                    self.resume_url = session["resumeUrl"]
                    self.sequence = self.saved_sequence = session["sequence"]
                    self.bot_user_id = session["botUserId"]
                if await self.ctx.storage.get("gatewayEnabled") is True:
                    self.enabled = True
                    await self.watchdog()
                    await self.connect()
            self.initialized = True

    async def health(self):
        await self.initialize()
        return {
            "connected": self.socket is not None and self.socket.ready_state == 1,
            "resumable": bool(self.session_id and self.resume_url),
            "stopped": await self.ctx.storage.get("gatewayStopped") is True,
        }

    async def start(self):
        await self.initialize()
        if not self.canonical():
            return {"ok": False}
        await self.ctx.storage.delete("gatewayStopped")
        await self.enable()
        # An operator start retries now; Discord's identify budget is still checked.
        self.attempts, self.identify_after = 0, 0.0
        await self.connect()
        return {"ok": True}

    async def ensure_connected(self):
        await self.initialize()
        if not self.canonical():
            return {"ok": False}
        if await self.ctx.storage.get("gatewayStopped") is True:
            return {"ok": False, "stopped": True}
        await self.enable()
        if not self.reconnect_timer:
            await self.connect()
        return {"ok": True}

    async def enable(self):
        await self.ctx.storage.put("gatewayEnabled", True)
        self.enabled = True
        await self.watchdog()

    async def stop(self):
        await self.initialize()
        self.enabled = False
        self.clear_reconnect()
        self.close_socket(1000, "stop")
        self.reset_session()
        await self.ctx.storage.delete("gatewayEnabled")
        await self.ctx.storage.put("gatewayStopped", True)
        await self.ctx.storage.deleteAlarm()
        return {"ok": True}

    async def watchdog(self):
        await self.ctx.storage.setAlarm(now_ms() + WATCHDOG_MS)

    async def alarm(self):
        try:
            await self.initialize()
            if not self.canonical():
                return
            if await self.ctx.storage.get("gatewayEnabled") is True:
                self.enabled = True
                # A pending reconnect keeps its backoff; restarts have no timer and connect now.
                if not self.reconnect_timer:
                    await self.connect()
                await self.watchdog()
            await self.sweep_markers()
        except Exception:
            # The runtime drops an alarm after repeated failures; keep the watchdog alive.
            log.error("gateway_alarm_failed")
            await self.watchdog()

    async def sweep_markers(self):
        now = now_ms()
        if now - self.swept_at < SWEEP_INTERVAL_MS:
            return
        self.swept_at = now
        markers = await self.ctx.storage.list({"prefix": "processed:"})
        stale = [key for key, at in markers.items() if at <= now - MARKER_TTL_MS]
        for start in range(0, len(stale), STORAGE_DELETE_LIMIT):
            await self.ctx.storage.delete(stale[start : start + STORAGE_DELETE_LIMIT])

    async def connect(self):
        async with self.connecting:
            if not self.enabled or (self.socket and self.socket.ready_state in (0, 1)):
                return
            self.clear_reconnect()
            self.close_socket(4000, "reconnect")
            if self.session_id and self.resume_url:
                url = gateway_url(self.resume_url)
            else:
                url = await self.identify_url()
                if url is None or not self.enabled:
                    return
            socket: Any = self.socket_factory(
                url + "/?v=10&encoding=json",
                lambda text: self.on_message(socket, text),
                lambda code: self.on_close(socket, code),
                lambda: self.on_error(socket),
            )
            self.socket = socket

    async def identify_url(self):
        """Return Discord's gateway URL while its daily IDENTIFY budget allows a new session."""
        wait = self.identify_after - time.time()
        if wait > 0:
            self.schedule_reconnect(wait)
            return None
        try:
            info = await self.app.discord.gateway_bot()
        except Exception:
            log.warning("gateway_session_limit_unavailable")
            self.schedule_reconnect()
            return None
        limit = info["session_start_limit"]
        if limit["remaining"] < 1:
            # Exceeding the limit makes Discord reset the bot token.
            wait = max(limit["reset_after"] / 1000, self.backoff())
            self.identify_after = time.time() + wait
            log.error("gateway_identify_budget_exhausted reset_after_s=%d", wait)
            self.schedule_reconnect(wait)
            return None
        return gateway_url(info["url"])

    def on_message(self, socket, text):
        if socket is not self.socket:
            return
        try:
            payload = json.loads(str(text))
            sequence = payload.get("s")
            if sequence is not None:
                self.sequence = sequence
        except TypeError, ValueError:
            log.warning("gateway_payload_parse_failed")
            return
        data = payload.get("d")
        match (payload["op"], payload.get("t")):
            case (10, _):  # Hello
                self.start_heartbeat(data["heartbeat_interval"] / 1000)
                self.identify_or_resume()
            case (11, _):  # Heartbeat acknowledged
                self.heartbeat_acknowledged = True
                if self.session_id and self.sequence != self.saved_sequence:
                    self.background(self.save_session())
            case (1, _):  # Heartbeat requested
                self.send_heartbeat()
            case (9, _):  # Invalid session; Discord asks for a random 1-5 s wait.
                if not data:
                    self.reset_session()
                self.reconnect(max(random.uniform(1, 5), self.backoff()))
            case (7, _):  # Reconnect requested
                self.reconnect()
            case (0, "READY"):
                self.session_id = data["session_id"]
                self.resume_url = data["resume_gateway_url"]
                self.bot_user_id = data["user"]["id"]
                self.attempts = 0
                self.background(self.save_session())
                log.info("gateway_ready")
            case (0, "RESUMED"):
                self.attempts = 0
                log.info("gateway_resumed")
            case (0, "MESSAGE_CREATE"):
                # Claim before scheduling/awaiting; duplicate events cannot race.
                if data["id"] in self.processed:
                    return
                self.processed[data["id"]] = None
                if len(self.processed) > 2000:
                    self.processed.popitem(last=False)
                self.background(self.process_message(data))

    async def process_message(self, message):
        key = f"processed:{message['id']}"
        if await self.ctx.storage.get(key) is not None:
            return
        await self.ctx.storage.put(key, now_ms())
        await self.app.handle_message(message, self.bot_user_id)

    def on_close(self, socket, code):
        if socket is not self.socket:
            return
        self.clear_heartbeat()
        self.socket = None
        # Let the active callback finish before destroying its proxy.
        asyncio.get_running_loop().call_soon(socket.dispose)
        if code in FATAL_CLOSE_CODES:
            log.error("gateway_fatal_close code=%s", code)
            self.enabled = False
            self.clear_reconnect()
            self.reset_session()
            self.background(self.disable_after_fatal())
            return
        log.warning("gateway_closed code=%s", code)
        if code in NON_RESUMABLE_CLOSE_CODES:
            self.reset_session()
        self.schedule_reconnect()

    async def disable_after_fatal(self):
        await self.ctx.storage.delete("gatewayEnabled")
        await self.ctx.storage.deleteAlarm()

    def on_error(self, socket):
        if socket is self.socket:
            self.schedule_reconnect()

    def identify_or_resume(self):
        if self.session_id and self.resume_url:
            self.send(
                {
                    "op": 6,
                    "d": {
                        "token": self.env.DISCORD_BOT_TOKEN,
                        "session_id": self.session_id,
                        "seq": self.sequence,
                    },
                }
            )
        else:
            self.send(
                {
                    "op": 2,
                    "d": {
                        "token": self.env.DISCORD_BOT_TOKEN,
                        "intents": (1 << 9) | (1 << 12) | (1 << 15),
                        "properties": {
                            "os": "linux",
                            "browser": "ragbot-worker",
                            "device": "ragbot-worker",
                        },
                    },
                }
            )

    def start_heartbeat(self, interval):
        self.clear_heartbeat()
        self.heartbeat_acknowledged = True

        def tick():
            if not self.heartbeat_acknowledged:
                log.warning("gateway_heartbeat_missed")
                self.reconnect()
                return
            self.send_heartbeat()
            self.heartbeat_timer = asyncio.get_running_loop().call_later(interval, tick)

        # Discord asks for the first heartbeat after a random fraction of the interval.
        first = interval * random.random()
        self.heartbeat_timer = asyncio.get_running_loop().call_later(first, tick)

    def send_heartbeat(self):
        self.heartbeat_acknowledged = False
        self.send({"op": 1, "d": self.sequence})

    def send(self, payload):
        if self.socket and self.socket.ready_state == 1:
            self.socket.send(json.dumps(payload))

    def close_socket(self, code, reason):
        self.clear_heartbeat()
        socket, self.socket = self.socket, None
        if socket:
            # Closing from a message callback must not destroy that callback mid-call.
            asyncio.get_running_loop().call_soon(socket.close, code, reason)

    def clear_heartbeat(self):
        if self.heartbeat_timer:
            self.heartbeat_timer.cancel()
            self.heartbeat_timer = None

    def clear_reconnect(self):
        if self.reconnect_timer:
            self.reconnect_timer.cancel()
            self.reconnect_timer = None

    async def save_session(self):
        """Persist resumable state. A stale sequence only replays events already deduplicated."""
        if not self.session_id:
            await self.ctx.storage.delete("gatewaySession")
            return
        self.saved_sequence = self.sequence
        await self.ctx.storage.put(
            "gatewaySession",
            {
                "sessionId": self.session_id,
                "resumeUrl": self.resume_url,
                "sequence": self.sequence,
                "botUserId": self.bot_user_id,
            },
        )

    def reset_session(self):
        self.sequence = self.session_id = self.resume_url = None
        self.background(self.save_session())

    def backoff(self):
        """Exponential reconnect delay with jitter; READY or RESUMED resets it."""
        self.attempts += 1
        return min(2 ** min(self.attempts - 1, 9), MAX_RECONNECT_DELAY) + random.random()

    def reconnect(self, delay=None):
        self.close_socket(4000, "reconnect")
        self.schedule_reconnect(delay)

    def schedule_reconnect(self, delay=None):
        if not self.enabled or self.reconnect_timer:
            return
        if delay is None:
            delay = self.backoff()
        log.warning("gateway_reconnect_scheduled attempt=%s delay_s=%.1f", self.attempts, delay)

        def retry():
            self.reconnect_timer = None
            self.close_socket(4000, "reconnect")
            self.background(self.connect())

        self.reconnect_timer = asyncio.get_running_loop().call_later(delay, retry)
