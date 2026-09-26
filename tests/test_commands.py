import json
from pathlib import Path

import pytest

from ragbot.commands import COMMANDS
from ragbot.commands.registry import ADMIN_IDS

TARGET = "123456789012345682"
USER_OPTION = {"name": "user", "type": 6, "value": TARGET}


def test_registration_payload_matches_existing_commands():
    expected = json.loads(Path("tests/fixtures/command_payload.json").read_text())
    assert sorted((c.data for c in COMMANDS.values()), key=lambda c: c["name"]) == sorted(
        expected, key=lambda c: c["name"]
    )


async def test_rag_and_undo_transaction(app, interaction):
    await app.dispatch(interaction("rag", options=[USER_OPTION]))
    assert app.transport.writes()[-1]["content"].endswith("Total: 1")
    assert app.transport.writes()[-1]["allowed_mentions"] == {"parse": [], "users": [TARGET]}
    await app.dispatch(interaction("rag", options=[USER_OPTION]))
    await app.dispatch(interaction("undorag", user=next(iter(ADMIN_IDS)), options=[USER_OPTION]))
    assert app.transport.writes()[-1]["content"].endswith("Total: 1")
    assert len(await app.db.all("SELECT * FROM rag_events")) == 1
    await app.dispatch(interaction("ragboard"))
    assert "target" in app.transport.writes()[-1]["content"]


async def test_guild_and_admin_denial_have_no_writes(app, interaction):
    await app.dispatch(interaction("rag", guild="999999999999999999", options=[USER_OPTION]))
    await app.dispatch(interaction("raghammer", options=[USER_OPTION]))
    assert not await app.db.all("SELECT * FROM rag_events")
    assert not await app.db.all("SELECT * FROM rag_command_bans")
    assert "not allowed" in app.transport.writes()[-1]["content"]


async def test_ban_gates_rag_and_ai_then_unban(app, interaction):
    options = [USER_OPTION, {"name": "timeframe", "value": "1h"}]
    await app.dispatch(interaction("raghammer", user=next(iter(ADMIN_IDS)), options=options))
    for command in ("rag", "ask", "bicture", "ragjam"):
        await app.dispatch(interaction(command, user=TARGET, options=[USER_OPTION]))
        assert "cannot use" in app.transport.writes()[-1]["content"]
    assert not await app.db.all("SELECT * FROM rag_ai_requests")
    await app.dispatch(interaction("ragunban", user=next(iter(ADMIN_IDS)), options=[USER_OPTION]))
    assert not await app.db.active_ban(TARGET)


@pytest.mark.parametrize("timeframe", ["0m", "-1h", "x", "366d", "99999999999999999999999d"])
async def test_invalid_ban_duration(app, interaction, timeframe):
    await app.dispatch(
        interaction(
            "raghammer",
            user=next(iter(ADMIN_IDS)),
            options=[USER_OPTION, {"name": "timeframe", "value": timeframe}],
        )
    )
    assert not await app.db.all("SELECT * FROM rag_command_bans")


async def test_ask_creates_thread_records_cost_and_final_reply(app, interaction):
    await app.dispatch(interaction("ask", options=[{"name": "prompt", "value": "explain trees"}]))
    assert len(await app.db.all("SELECT * FROM rag_ai_threads")) == 1
    spend = await app.db.all("SELECT * FROM rag_ai_spend_events")
    assert spend[0]["status"] == "pending"
    analytics = await app.db.all("SELECT * FROM rag_ai_interactions")
    assert analytics[0]["status"] == "ok"
    assert analytics[0]["response_text"] == "hello <https://example.com>"
    assert app.transport.writes()[-1]["content"] == analytics[0]["response_text"]
    for url, options in app.transport.calls:
        if "/webhooks/" in url:
            assert "authorization" not in options["headers"]


async def test_ai_burst_limit(app):
    for _ in range(8):
        assert await app.db.usage_denial(app.env, TARGET, "ask") is None
    assert "Slow down" in await app.db.usage_denial(app.env, TARGET, "ask")


async def test_ai_guard_fails_open(app):
    app.db.binding.connection.close()
    assert await app.db.usage_denial(app.env, TARGET, "ask") is None
    assert await app.db.active_ban(TARGET, fail_open=True) is None
