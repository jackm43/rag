"""Discord gateway lifecycle, owned by one Durable Object."""

import asyncio
import json
import logging
import math
import time
from collections import OrderedDict
from typing import Any
from urllib.parse import urlparse

from .discord import is_message
from .runtime import to_python

log = logging.getLogger("ragbot")
GATEWAY_NAME = "discord-gateway-v2"
FATAL_CLOSE_CODES = frozenset({4004, 4010, 4011, 4012, 4013, 4014})
NON_RESUMABLE_CLOSE_CODES = frozenset({4007, 4009})


def gateway_stub(env):
    return env.DISCORD_GATEWAY.get(env.DISCORD_GATEWAY.idFromName(GATEWAY_NAME))


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
        self.heartbeat_acknowledged = True
        self.processed: OrderedDict[str, None] = OrderedDict()
        self.tasks: set[asyncio.Task] = set()
        self.initialized = False
        self.lock = asyncio.Lock()
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
        self.ctx.waitUntil(task)

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
            elif await self.ctx.storage.get("gatewayEnabled") is True:
                self.enabled = True
                await self.watchdog()
                self.connect()
            self.initialized = True

    async def health(self):
        await self.initialize()
        return {
            "connected": self.socket is not None and self.socket.ready_state == 1,
            "resumable": bool(self.session_id and self.resume_url),
        }

    async def start(self):
        await self.initialize()
        if not self.canonical():
            return {"ok": False}
        await self.ctx.storage.delete("gatewayStopped")
        await self.enable()
        self.connect()
        return {"ok": True}

    async def ensure_connected(self):
        await self.initialize()
        if not self.canonical():
            return {"ok": False}
        if await self.ctx.storage.get("gatewayStopped") is True:
            return {"ok": False, "stopped": True}
        await self.enable()
        self.connect()
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
        await self.ctx.storage.setAlarm(round(time.time() * 1000) + 300000)

    async def alarm(self):
        await self.initialize()
        if not self.canonical():
            return
        markers = to_python(await self.ctx.storage.list({"prefix": "processed:"}))
        cutoff = time.time() * 1000 - 86400000
        stale = [key for key, at in markers.items() if at <= cutoff]
        if stale:
            await self.ctx.storage.delete(stale)
        if await self.ctx.storage.get("gatewayEnabled") is True:
            self.enabled = True
            self.connect()
            await self.watchdog()

    def connect(self):
        if not self.enabled or (self.socket and self.socket.ready_state in (0, 1)):
            return
        self.clear_reconnect()
        self.close_socket(4000, "reconnect")
        # Discord sends regional resume endpoints. Do not send the bot token to arbitrary hosts.
        host = urlparse(self.resume_url or "").hostname or ""
        base = (
            self.resume_url
            if self.resume_url
            and host.endswith(".discord.gg")
            and self.resume_url.startswith("wss://")
            else "wss://gateway.discord.gg"
        )
        socket: Any = self.socket_factory(
            base.rstrip("/") + "/?v=10&encoding=json",
            lambda text: self.on_message(socket, text),
            lambda code: self.on_close(socket, code),
            lambda: self.on_error(socket),
        )
        self.socket = socket

    def on_message(self, socket, text):
        if socket is not self.socket:
            return
        try:
            payload = json.loads(str(text))
            if not isinstance(payload, dict) or not isinstance(payload.get("op"), int):
                return
            sequence = payload.get("s")
            if sequence is not None:
                if not isinstance(sequence, int):
                    return
                self.sequence = sequence
        except TypeError, ValueError:
            log.warning("gateway_payload_parse_failed")
            return
        op, data = payload["op"], payload.get("d")
        if op == 10:
            interval = data.get("heartbeat_interval") if isinstance(data, dict) else None
            if isinstance(interval, (int, float)) and math.isfinite(interval) and interval > 0:
                self.start_heartbeat(interval / 1000)
                self.identify_or_resume()
        elif op == 11:
            self.heartbeat_acknowledged = True
        elif op == 1:
            self.send_heartbeat()
        elif op == 9:
            if data is not True:
                self.reset_session()
            self.reconnect()
        elif op == 7:
            self.reconnect()
        elif op == 0:
            if (
                payload.get("t") == "READY"
                and isinstance(data, dict)
                and isinstance(data.get("session_id"), str)
            ):
                self.session_id = data["session_id"]
                self.resume_url = data.get("resume_gateway_url") or self.resume_url
                self.bot_user_id = (data.get("user") or {}).get("id") or self.bot_user_id
            elif (
                payload.get("t") == "MESSAGE_CREATE" and isinstance(data, dict) and is_message(data)
            ):
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
        await self.ctx.storage.put(key, round(time.time() * 1000))
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
        self.send_heartbeat()

        def tick():
            if not self.heartbeat_acknowledged:
                self.reconnect()
                return
            self.send_heartbeat()
            self.heartbeat_timer = asyncio.get_running_loop().call_later(interval, tick)

        self.heartbeat_timer = asyncio.get_running_loop().call_later(interval, tick)

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

    def reset_session(self):
        self.sequence = self.session_id = self.resume_url = None

    def reconnect(self):
        self.close_socket(4000, "reconnect")
        self.schedule_reconnect()

    def schedule_reconnect(self):
        if not self.enabled or self.reconnect_timer:
            return

        def retry():
            self.reconnect_timer = None
            self.close_socket(4000, "reconnect")
            self.connect()

        self.reconnect_timer = asyncio.get_running_loop().call_later(5, retry)
