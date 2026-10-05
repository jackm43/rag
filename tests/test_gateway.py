"""Gateway reconnect, resume and identify-budget policies with an injected socket."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from ragbot.gateway import GATEWAY_NAME, Gateway, now_ms

RESUME_URL = "wss://us-east1-b.gateway.discord.gg/"


class Storage:
    """Durable Object storage subset, including its 128-key batch delete limit."""

    def __init__(self, **data):
        self.data, self.alarm = dict(data), None

    async def get(self, key):
        return self.data.get(key)

    async def put(self, key, value):
        self.data[key] = value

    async def delete(self, keys):
        if isinstance(keys, list):
            assert len(keys) <= 128
            for key in keys:
                self.data.pop(key, None)
        else:
            self.data.pop(keys, None)

    async def list(self, options):
        return {k: v for k, v in self.data.items() if k.startswith(options["prefix"])}

    async def setAlarm(self, at):
        self.alarm = at

    async def deleteAlarm(self):
        self.alarm = None

    async def deleteAll(self):
        self.data.clear()


class FakeSocket:
    def __init__(self, url, on_message, on_close, on_error):
        self.url, self.on_message, self.on_close = url, on_message, on_close
        self.ready_state, self.sent, self.closed = 1, [], None

    def send(self, text):
        self.sent.append(json.loads(text))

    def close(self, code, reason):
        self.ready_state, self.closed = 3, code

    def dispose(self):
        pass

    def receive(self, payload):
        self.on_message(json.dumps(payload))

    def ready(self, sequence=1):
        self.receive({"op": 10, "d": {"heartbeat_interval": 41250}})
        self.receive(
            {
                "op": 0,
                "s": sequence,
                "t": "READY",
                "d": {"session_id": "s1", "resume_gateway_url": RESUME_URL, "user": {"id": "bot"}},
            }
        )


class Identity:
    def __init__(self, name):
        self.name = name

    def equals(self, other):
        return self.name == other.name


async def settle(gateway):
    # Yield every round: gathering finished tasks does not run their done callbacks.
    while True:
        await asyncio.sleep(0)
        if not gateway.tasks:
            return
        await asyncio.gather(*list(gateway.tasks))


def delay(timer):
    return timer.when() - asyncio.get_running_loop().time()


@pytest.fixture
async def gateways():
    created = []

    def make(storage=None, *, remaining=1000):
        sockets: list[FakeSocket] = []

        def factory(*args):
            sockets.append(FakeSocket(*args))
            return sockets[-1]

        limit = {"total": 1000, "remaining": remaining, "reset_after": 60000, "max_concurrency": 1}
        discord = SimpleNamespace(
            gateway_bot=AsyncMock(
                return_value={"url": "wss://gateway.discord.gg", "session_start_limit": limit}
            )
        )
        gateway = Gateway(
            SimpleNamespace(
                id=Identity(GATEWAY_NAME),
                storage=storage or Storage(),
                waitUntil=lambda task: None,
            ),
            SimpleNamespace(
                DISCORD_BOT_TOKEN="test-bot-token",
                DISCORD_GATEWAY=SimpleNamespace(idFromName=Identity),
            ),
            SimpleNamespace(discord=discord, handle_message=AsyncMock()),
            socket_factory=factory,
        )
        created.append(gateway)
        return gateway, sockets

    yield make
    for gateway in created:
        gateway.enabled = False
        gateway.clear_reconnect()
        gateway.clear_heartbeat()
        await settle(gateway)


async def test_identify_waits_for_discord_session_start_budget(gateways):
    gateway, sockets = gateways(remaining=0)
    assert await gateway.start() == {"ok": True}
    assert sockets == []
    assert 59 < delay(gateway.reconnect_timer) <= 60
    # Cron and the watchdog leave the deferred reconnect in place.
    assert await gateway.ensure_connected() == {"ok": True}
    await gateway.alarm()
    assert sockets == [] and gateway.app.discord.gateway_bot.await_count == 1


async def test_identify_connects_only_to_discord_gateway_hosts(gateways):
    gateway, sockets = gateways()
    gateway.app.discord.gateway_bot.return_value["url"] = "wss://gateway.example.com"
    await gateway.start()
    sockets[0].receive({"op": 10, "d": {"heartbeat_interval": 41250}})
    assert sockets[0].url == "wss://gateway.discord.gg/?v=10&encoding=json"
    assert [payload["op"] for payload in sockets[0].sent] == [2]


async def test_restarted_object_resumes_stored_session(gateways):
    storage = Storage()
    first, sockets = gateways(storage)
    await first.start()
    sockets[0].ready()
    sockets[0].receive({"op": 0, "s": 7, "t": "TYPING_START", "d": {}})
    sockets[0].receive({"op": 11})
    await settle(first)
    assert storage.data["gatewaySession"] == {
        "sessionId": "s1",
        "resumeUrl": RESUME_URL,
        "sequence": 7,
        "botUserId": "bot",
    }

    second, resumed = gateways(storage)
    await second.alarm()
    assert resumed[0].url == "wss://us-east1-b.gateway.discord.gg/?v=10&encoding=json"
    resumed[0].receive({"op": 10, "d": {"heartbeat_interval": 41250}})
    assert resumed[0].sent == [
        {"op": 6, "d": {"token": "test-bot-token", "session_id": "s1", "seq": 7}}
    ]
    assert second.bot_user_id == "bot"
    assert second.app.discord.gateway_bot.await_count == 0

    await second.stop()
    await settle(second)
    assert "gatewaySession" not in storage.data and storage.alarm is None


@pytest.mark.parametrize(
    ("code", "resumable", "retries"),
    [(1006, True, True), (4003, False, True), (4009, False, True), (4014, False, False)],
)
async def test_close_code_policy(gateways, code, resumable, retries):
    gateway, sockets = gateways()
    await gateway.start()
    sockets[0].ready()
    await settle(gateway)
    sockets[0].on_close(code)
    await settle(gateway)
    storage = gateway.ctx.storage.data
    assert bool(gateway.session_id) is resumable
    assert ("gatewaySession" in storage) is resumable
    assert (gateway.reconnect_timer is not None) is retries
    assert ("gatewayEnabled" in storage) is retries


async def test_reconnect_backoff_grows_until_ready(gateways, monkeypatch):
    monkeypatch.setattr("ragbot.gateway.random.random", lambda: 0)
    gateway, sockets = gateways()
    await gateway.start()
    delays = []
    for _ in range(4):
        sockets[-1].on_close(1006)
        delays.append(round(delay(gateway.reconnect_timer)))
        # Cron and the watchdog keep a pending backoff.
        await gateway.ensure_connected()
        await gateway.alarm()
        assert gateway.reconnect_timer is not None
        gateway.clear_reconnect()
        await gateway.connect()
    assert delays == [1, 2, 4, 8] and len(sockets) == 5
    sockets[-1].ready()
    sockets[-1].on_close(1006)
    assert round(delay(gateway.reconnect_timer)) == 1


async def test_invalid_session_waits_before_identifying(gateways):
    gateway, sockets = gateways()
    await gateway.start()
    sockets[0].ready()
    sockets[0].receive({"op": 9, "d": False})
    await settle(gateway)
    assert 0.9 < delay(gateway.reconnect_timer) <= 5
    assert sockets[0].closed == 4000
    assert gateway.session_id is None and "gatewaySession" not in gateway.ctx.storage.data


async def test_first_heartbeat_is_jittered_and_missed_ack_reconnects(gateways, monkeypatch):
    monkeypatch.setattr("ragbot.gateway.random.random", lambda: 0.5)
    gateway, sockets = gateways()
    await gateway.start()
    sockets[0].receive({"op": 10, "d": {"heartbeat_interval": 100}})
    await asyncio.sleep(0.025)
    assert [payload["op"] for payload in sockets[0].sent] == [2]
    await asyncio.sleep(0.05)
    assert sockets[0].sent[-1] == {"op": 1, "d": None}
    await asyncio.sleep(0.125)
    assert sockets[0].closed == 4000 and gateway.reconnect_timer is not None


async def test_alarm_sweeps_markers_within_storage_limits(gateways):
    storage = Storage(**{f"processed:{i}": 0 for i in range(300)}, **{"processed:new": now_ms()})
    gateway, _ = gateways(storage)
    await gateway.alarm()
    assert [key for key in storage.data if key.startswith("processed:")] == ["processed:new"]
    # Sweeps run hourly even though the watchdog fires every minute.
    storage.data["processed:old"] = 0
    await gateway.alarm()
    assert "processed:old" in storage.data


async def test_failed_alarm_rearms_watchdog(gateways):
    storage = Storage()
    storage.get = AsyncMock(side_effect=RuntimeError("storage unavailable"))
    gateway, _ = gateways(storage)
    await gateway.alarm()
    assert storage.alarm is not None
