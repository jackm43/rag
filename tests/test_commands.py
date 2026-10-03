import pytest

from ragbot.commands.registry import ADMIN_IDS, MODS_ROLE_ID

TARGET = "123456789012345682"
USER_OPTION = {"name": "user", "type": 6, "value": TARGET}


async def test_coinflip_draws_a_fresh_random_bit_for_each_reply(app, interaction, monkeypatch):
    from unittest.mock import Mock

    from ragbot.commands import COMMANDS

    draw = Mock(side_effect=[0, 1, 1, 0])
    monkeypatch.setattr("ragbot.commands.coinflip.secrets.randbits", draw)
    assert COMMANDS["coinflip"].data == {
        "name": "coinflip",
        "description": "Flip a fair coin: heads or tails",
    }
    for expected in ("heads", "tails", "tails", "heads"):
        await app.dispatch(interaction("coinflip"))
        reply = app.transport.writes()[-1]
        assert reply["content"] == expected
        assert reply["allowed_mentions"] == {"parse": []}
    assert draw.call_count == 4
    assert all(call.args == (1,) for call in draw.call_args_list)


async def test_rag_and_undo_transaction(app, interaction):
    await app.dispatch(interaction("rag", options=[USER_OPTION]))
    assert app.transport.writes()[-1]["content"].endswith("Total: 1")
    assert app.transport.writes()[-1]["allowed_mentions"] == {"parse": [], "users": [TARGET]}
    await app.dispatch(interaction("rag", options=[USER_OPTION]))
    await app.dispatch(interaction("undorag", roles=[MODS_ROLE_ID], options=[USER_OPTION]))
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


async def test_ban_gates_rag_then_unban(app, interaction):
    options = [USER_OPTION, {"name": "timeframe", "value": "1h"}]
    await app.dispatch(interaction("raghammer", roles=[MODS_ROLE_ID], options=options))
    await app.dispatch(interaction("rag", user=TARGET, options=[USER_OPTION]))
    assert "cannot use" in app.transport.writes()[-1]["content"]
    await app.dispatch(interaction("ragunban", user=next(iter(ADMIN_IDS)), options=[USER_OPTION]))
    assert not await app.db.active_ban(TARGET)


@pytest.mark.parametrize("timeframe", ["0m", "-1h", "x", "366d", "99999999999999999999999d"])
async def test_invalid_ban_duration(app, interaction, timeframe):
    await app.dispatch(
        interaction(
            "raghammer",
            roles=[MODS_ROLE_ID],
            options=[USER_OPTION, {"name": "timeframe", "value": timeframe}],
        )
    )
    assert not await app.db.all("SELECT * FROM rag_command_bans")


@pytest.mark.parametrize("name", ["undorag", "raghammer"])
@pytest.mark.parametrize("roles", [None, [], ["123456789012345678"], MODS_ROLE_ID])
@pytest.mark.parametrize("user", ["123456789012345679", *sorted(ADMIN_IDS)])
async def test_mod_commands_deny_without_role(app, interaction, name, roles, user):
    await app.dispatch(interaction("rag", options=[USER_OPTION]))
    request = interaction(
        name, user=user, options=[USER_OPTION, {"name": "timeframe", "value": "1h"}]
    )
    request["member"]["roles"] = roles
    await app.dispatch(request)
    assert "Mods role is required" in app.transport.writes()[-1]["content"]
    assert len(await app.db.all("SELECT * FROM rag_events")) == 1
    assert not await app.db.all("SELECT * FROM rag_command_bans")


@pytest.mark.parametrize("name", ["undorag", "raghammer"])
async def test_mod_commands_deny_missing_member(app, interaction, name):
    request = interaction(name, options=[USER_OPTION])
    request["user"] = request.pop("member")["user"]
    await app.dispatch(request)
    assert "Mods role is required" in app.transport.writes()[-1]["content"]


@pytest.mark.parametrize("name", ["ask"])
async def test_removed_commands_are_unknown(app, interaction, name):
    from ragbot.commands import COMMANDS

    assert name not in COMMANDS
    await app.dispatch(interaction(name))
    assert app.transport.writes()[-1]["content"] == "Unknown command."
    assert not await app.db.all("SELECT * FROM rag_ai_requests")
