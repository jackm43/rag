import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from ragbot.gateway import FATAL_CLOSE_CODES, Gateway


class Storage:
    def __init__(self):
        self.values = {}
        self.alarm_at = None

    async def get(self, key):
        return self.values.get(key)

    async def put(self, key, value):
        self.values[key] = value

    async def delete(self, key):
        for item in key if isinstance(key, list) else [key]:
            self.values.pop(item, None)

    async def deleteAll(self):
        self.values.clear()

    async def setAlarm(self, value):
        self.alarm_at = value

    async def deleteAlarm(self):
        self.alarm_at = None

    async def list(self, options):
        return {
            key: value for key, value in self.values.items() if key.startswith(options["prefix"])
        }


class FakeSocket:
    def __init__(self, url, message, close, error):
        self.url, self.on_message, self.on_close, self.on_error = url, message, close, error
        self.ready_state, self.sent, self.disposed = 1, [], False

    def send(self, text):
        self.sent.append(json.loads(text))

    def close(self, code, reason):
        self.ready_state = 3
        self.disposed = True

    def dispose(self):
        self.disposed = True


@pytest.fixture
async def gateway(app):
    app.env.DISCORD_GATEWAY = SimpleNamespace(idFromName=lambda name: name)
    ctx = SimpleNamespace(
        storage=Storage(),
        id=SimpleNamespace(equals=lambda other: True),
        waitUntil=lambda task: None,
    )
    app.handle_message = AsyncMock()
    gateway = Gateway(ctx, app.env, app, socket_factory=FakeSocket)
    yield gateway
    await gateway.stop()
    await asyncio.sleep(0)


async def test_stop_survives_recreation_and_cron(gateway):
    await gateway.start()
    assert (await gateway.health())["connected"]
    await gateway.stop()
    assert (await gateway.health())["stopped"] is True
    recreated = Gateway(gateway.ctx, gateway.env, gateway.app, socket_factory=FakeSocket)
    assert await recreated.ensure_connected() == {"ok": False, "stopped": True}
    assert recreated.socket is None
    await recreated.alarm()
    assert recreated.ctx.storage.alarm_at is None
    await recreated.start()
    assert recreated.socket is not None
    await recreated.stop()


@pytest.mark.parametrize("code", sorted(FATAL_CLOSE_CODES))
async def test_fatal_close_disables_retry_until_cron(gateway, code):
    await gateway.start()
    socket = gateway.socket
    socket.on_close(code)
    await asyncio.gather(*gateway.tasks)
    assert gateway.reconnect_timer is None
    assert gateway.ctx.storage.alarm_at is None
    assert "gatewayEnabled" not in gateway.ctx.storage.values
    await gateway.ensure_connected()
    assert gateway.socket is not None


async def test_identify_heartbeat_resume_and_invalid_session(gateway):
    await gateway.start()
    socket = gateway.socket
    socket.on_message(json.dumps({"op": 10, "d": {"heartbeat_interval": 45000}}))
    assert [p["op"] for p in socket.sent] == [1, 2]
    assert socket.sent[-1]["d"]["intents"] == 37376
    socket.on_message(json.dumps({"op": 11}))
    assert gateway.heartbeat_acknowledged
    socket.on_message(
        json.dumps(
            {
                "op": 0,
                "s": 42,
                "t": "READY",
                "d": {
                    "session_id": "session",
                    "resume_gateway_url": "wss://gateway-us-east1-b.discord.gg",
                    "user": {"id": "123456789012345678"},
                },
            }
        )
    )
    gateway.reconnect()
    gateway.connect()
    gateway.socket.on_message(json.dumps({"op": 10, "d": {"heartbeat_interval": 45000}}))
    assert gateway.socket.sent[-1]["op"] == 6
    assert gateway.socket.sent[-1]["d"]["seq"] == 42
    gateway.socket.on_close(4007)
    assert gateway.session_id is None


async def test_dedupe_is_durable_and_pruned(gateway):
    await gateway.start()
    message = {"id": "123456789012345680", "channel_id": "123456789012345681", "content": "hi"}
    payload = json.dumps({"op": 0, "t": "MESSAGE_CREATE", "d": message})
    gateway.socket.on_message(payload)
    gateway.socket.on_message(payload)
    await asyncio.gather(*gateway.tasks)
    gateway.app.handle_message.assert_awaited_once()
    gateway.processed.clear()
    gateway.socket.on_message(payload)
    await asyncio.gather(*gateway.tasks)
    gateway.app.handle_message.assert_awaited_once()
    gateway.ctx.storage.values["processed:old"] = 0
    await gateway.alarm()
    assert "processed:old" not in gateway.ctx.storage.values


async def test_stale_object_is_decommissioned(gateway):
    gateway.ctx.id.equals = lambda other: False
    gateway.ctx.storage.values.update(gatewayEnabled=True)
    await gateway.initialize()
    assert gateway.socket is None
    assert not gateway.ctx.storage.values
    assert not (await gateway.start())["ok"]
