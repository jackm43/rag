from unittest.mock import AsyncMock

import pytest

from ragbot.builds import BuildScope


@pytest.mark.parametrize("command,kind", [("build", "site"), ("feature", "feature")])
async def test_intake_is_durable_and_idempotent(app, interaction, command, kind):
    request = interaction(command, options=[{"name": "prompt", "value": "Build a word game"}])
    await app.dispatch(request)
    await app.dispatch(request)
    rows = await app.db.all("SELECT * FROM build_requests")
    assert len(rows) == 1
    assert rows[0]["kind"] == kind
    assert rows[0]["status"] == "submitted"
    assert rows[0]["prompt"] == "Build a word game"
    assert "waiting for the builder connection" in app.transport.writes()[-1]["content"]
    assert app.env.AI.run.await_count == 0
    assert all("discord.com" in url for url, _ in app.transport.calls)
    assert app.transport.writes()[-1]["allowed_mentions"] == {"parse": []}


@pytest.mark.parametrize("case", ["dm", "other_guild", "unset", "missing_member", "blank", "long"])
async def test_intake_denials(app, interaction, case):
    request = interaction("build", options=[{"name": "prompt", "value": "game"}])
    if case == "dm":
        request["guild_id"] = None
    elif case == "other_guild":
        request["guild_id"] = "999999999999999999"
    elif case == "unset":
        app.env.ALLOWED_GUILD_IDS = ""
    elif case == "missing_member":
        request["user"] = request.pop("member")["user"]
    else:
        request["data"]["options"][0]["value"] = " " if case == "blank" else "x" * 6001
    await app.dispatch(request)
    assert not await app.db.all("SELECT * FROM build_requests")


async def test_status_does_not_leak_across_channels_or_guilds(app, interaction):
    await app.dispatch(interaction("build", options=[{"name": "prompt", "value": "private idea"}]))
    row = (await app.db.all("SELECT * FROM build_requests"))[0]
    request = interaction("buildstatus", options=[{"name": "request", "value": row["id"]}])
    await app.dispatch(request)
    assert "submitted" in app.transport.writes()[-1]["content"]
    request["channel_id"] = "999999999999999999"
    await app.dispatch(request)
    assert app.transport.writes()[-1]["content"] == "Request not found in this channel."
    scope = BuildScope("999999999999999999", row["channel_id"], row["requester_user_id"])
    assert await app.builds.status(scope, row["id"]) is None
    assert all("private idea" not in w.get("content", "") for w in app.transport.writes())


async def test_database_failure_cannot_report_saved(app, interaction):
    app.db.run = AsyncMock(side_effect=RuntimeError("sensitive database error"))
    await app.dispatch(interaction("build", options=[{"name": "prompt", "value": "game"}]))
    assert app.transport.writes()[-1]["content"] == "Command failed. Try again."
    assert app.env.AI.run.await_count == 0


async def test_replayed_source_cannot_change_prompt_or_scope(app, interaction):
    request = interaction("build", options=[{"name": "prompt", "value": "original"}])
    await app.dispatch(request)
    request["data"]["options"][0]["value"] = "replacement"
    await app.dispatch(request)
    request["channel_id"] = "999999999999999999"
    await app.dispatch(request)
    assert app.transport.writes()[-1]["content"] == "Command failed. Try again."
    rows = await app.db.all("SELECT * FROM build_requests")
    assert len(rows) == 1
    assert rows[0]["prompt"] == "original"


async def test_connected_build_and_owner_actions(app, interaction):
    from types import SimpleNamespace

    app.env.BUILDER_ENABLED = "true"
    app.env.BUILDER = SimpleNamespace(
        submit=AsyncMock(return_value={"status": "building", "revision": 1}),
        action=AsyncMock(return_value={"status": "cancelled", "revision": 1}),
        passcode=AsyncMock(return_value={"code": "test-personal-code"}),
    )
    await app.dispatch(interaction("build", options=[{"name": "prompt", "value": "game"}]))
    row = (await app.db.all("SELECT * FROM build_requests"))[0]
    assert row["remote_status"] == "building"
    assert app.env.BUILDER.submit.call_args.args[0]["guild_id"] == row["guild_id"]
    option = [{"name": "request", "value": row["id"]}]
    await app.dispatch(interaction("buildcancel", user="999999999999999999", options=option))
    app.env.BUILDER.action.assert_not_called()
    await app.dispatch(interaction("buildcancel", options=option))
    assert (await app.db.all("SELECT * FROM build_requests"))[0]["remote_status"] == "cancelled"
    await app.dispatch(interaction("buildpass", options=option))
    assert "test-personal-code" in app.transport.writes()[-1]["content"]


async def test_outage_retains_request_for_reconciliation(app, interaction):
    from types import SimpleNamespace

    app.env.BUILDER_ENABLED = "true"
    app.env.BUILDER = SimpleNamespace(submit=AsyncMock(side_effect=RuntimeError("private")))
    await app.dispatch(interaction("build", options=[{"name": "prompt", "value": "game"}]))
    assert len(await app.db.all("SELECT * FROM build_requests")) == 1
    assert "waiting for the builder connection" in app.transport.writes()[-1]["content"]
    app.env.BUILDER.submit = AsyncMock(
        return_value={"status": "ready", "revision": 1, "url": "https://example.invalid"}
    )
    await app.builds.reconcile(app.discord)
    row = (await app.db.all("SELECT * FROM build_requests"))[0]
    assert row["remote_status"] == "ready"
    assert row["notice_id"]
    assert "https://example.invalid" in app.transport.writes()[-1]["content"]


async def test_explicit_build_mention_routes_without_chat(app):
    bot = app.env.DISCORD_APPLICATION_ID
    message = {
        "id": "123456789012345799",
        "guild_id": app.env.ALLOWED_GUILD_IDS,
        "channel_id": "123456789012345681",
        "author": {"id": "123456789012345679", "username": "user"},
        "content": f"<@{bot}> build a shared word game",
    }
    await app.handle_message(message, bot)
    row = (await app.db.all("SELECT * FROM build_requests"))[0]
    assert row["prompt"] == "a shared word game"
    assert app.env.AI.run.await_count == 0


async def test_coding_settings_migration_preserves_existing_live_values(app):
    import json
    from pathlib import Path

    from ragbot._bundled import FILES

    resources = dict(FILES)
    resources.pop("coding-agent.json")
    resources["discord-response-system-prompt.md"] = "Keep this live prompt"
    await app.db.run(
        "INSERT INTO ai_runtime_settings(id, revision, document) VALUES (1, ?, ?)",
        "old",
        json.dumps({"schemaVersion": 1, "revision": "old", "resources": resources}),
    )
    app.env.DB.connection.executescript(
        Path("migrations/0006_coding_agent_settings.sql").read_text()
    )
    snapshot = await app.config.snapshot()
    assert snapshot["resources"]["discord-response-system-prompt.md"] == "Keep this live prompt"
    assert snapshot["revision"] == "builder-v1-old"
    assert json.loads(snapshot["resources"]["coding-agent.json"])["model"] == "gpt-6-sol"


async def test_each_coding_request_reads_fresh_settings(app, interaction):
    import json
    from types import SimpleNamespace

    from ragbot._bundled import FILES

    app.env.BUILDER_ENABLED = "true"
    app.env.BUILDER = SimpleNamespace(
        submit=AsyncMock(return_value={"status": "building", "revision": 1})
    )
    request = interaction("build", options=[{"name": "prompt", "value": "game"}])
    await app.dispatch(request)
    assert app.env.BUILDER.submit.call_args.args[0]["model"] == "gpt-6-sol"
    resources = dict(FILES)
    config = json.loads(resources["coding-agent.json"])
    config["model"] = "test-coding-model"
    resources["coding-agent.json"] = json.dumps(config)
    await app.db.run(
        "INSERT INTO ai_runtime_settings(id, revision, document) VALUES (1, ?, ?)",
        "updated",
        json.dumps({"schemaVersion": 1, "revision": "updated", "resources": resources}),
    )
    request["id"] = "123456789012345789"
    await app.dispatch(request)
    assert app.env.BUILDER.submit.call_args.args[0]["model"] == "test-coding-model"
    assert app.env.BUILDER.submit.call_args.args[0]["config_revision"] == "updated"


async def test_workspace_creation_is_once_and_private_parent_is_preserved(app, interaction):
    from conftest import FakeResponse

    app.transport.handler = lambda url, opts: (
        FakeResponse({"id": "123456789012345681", "type": 0})
        if url.endswith("/channels/123456789012345681")
        else None
    )
    request = interaction("build", options=[{"name": "prompt", "value": "game"}])
    await app.dispatch(request)
    await app.dispatch(request)
    row = (await app.db.all("SELECT * FROM build_requests"))[0]
    assert row["thread_id"] == "123456789012345690"
    posts = [(u, o) for u, o in app.transport.calls if u.endswith("/threads")]
    assert len(posts) == 1
    assert posts[0][0].endswith(f"/channels/{row['channel_id']}/threads")
    assert "discord.com/channels/" in app.transport.writes()[-1]["content"]


async def test_ambiguous_thread_creation_is_not_retried(app, interaction):
    app.discord.create_thread = AsyncMock(side_effect=RuntimeError("lost response"))
    request = interaction("build", options=[{"name": "prompt", "value": "game"}])
    await app.dispatch(request)
    await app.dispatch(request)
    app.discord.create_thread.assert_awaited_once()
    row = (await app.db.all("SELECT * FROM build_requests"))[0]
    assert row["thread_id"] is None
    assert "thread is unavailable" in app.transport.writes()[-1]["content"]


async def test_request_inside_private_thread_does_not_create_public_sibling(app, interaction):
    from conftest import FakeResponse

    app.transport.handler = lambda url, opts: (
        FakeResponse({"type": 12}) if url.endswith("/channels/123456789012345681") else None
    )
    await app.dispatch(interaction("build", options=[{"name": "prompt", "value": "game"}]))
    assert not any(u.endswith("/threads") for u, _ in app.transport.calls)


async def workspace(app, interaction):
    from types import SimpleNamespace

    app.env.BUILDER_ENABLED = "true"
    app.env.BUILDER = SimpleNamespace(
        submit=AsyncMock(return_value={"status": "ready", "revision": 1}),
        action=AsyncMock(return_value={"status": "building", "revision": 2}),
        passcode=AsyncMock(return_value={"code": "private-code"}),
    )
    await app.dispatch(interaction("build", options=[{"name": "prompt", "value": "game"}]))
    return (await app.db.all("SELECT * FROM build_requests"))[0]


@pytest.mark.parametrize(
    "command,options",
    [
        ("buildedit", [{"name": "prompt", "value": "fix keyboard"}]),
        ("buildstatus", []),
        ("buildpass", []),
    ],
)
async def test_thread_commands_infer_project_and_preserve_remote_scope(
    app, interaction, command, options
):
    row = await workspace(app, interaction)
    request = interaction(command, options=options)
    request["channel_id"] = row["thread_id"]
    request["id"] = "123456789012345799"
    await app.dispatch(request)
    if command == "buildedit":
        payload = app.env.BUILDER.action.call_args.args[0]
        assert payload["id"] == row["id"]
        assert payload["channel_id"] == row["channel_id"]
        assert payload["prompt"] == "fix keyboard"
    elif command == "buildpass":
        assert "private-code" in app.transport.writes()[-1]["content"]
    else:
        assert "ready" in app.transport.writes()[-1]["content"]


@pytest.mark.parametrize("mode", ["owner", "moderator", "other", "webhook", "discussion", "status"])
async def test_thread_mentions_route_changes_without_chat(app, interaction, mode):
    row = await workspace(app, interaction)
    bot = app.env.DISCORD_APPLICATION_ID
    msg = {
        "id": "123456789012345799",
        "guild_id": row["guild_id"],
        "channel_id": row["thread_id"],
        "author": {"id": row["requester_user_id"], "username": "member"},
        "content": f"<@{bot}> fix the keyboard",
        "member": {"roles": []},
    }
    if mode in ("moderator", "other"):
        msg["author"]["id"] = "999999999999999999"
    if mode == "moderator":
        msg["member"]["roles"] = ["457695154892177418"]
    if mode == "webhook":
        msg["webhook_id"] = "123456789012345700"
        msg["author"]["bot"] = True
    if mode == "discussion":
        msg["content"] = "I like this game"
    if mode == "status":
        msg["content"] = f"<@{bot}> status"
    await app.handle_message(msg, bot)
    if mode in ("owner", "moderator"):
        payload = app.env.BUILDER.action.call_args.args[0]
        assert payload["prompt"] == "fix the keyboard"
        assert payload["channel_id"] == row["channel_id"]
        assert payload["moderator"] == (mode == "moderator")
    else:
        app.env.BUILDER.action.assert_not_called()
    assert app.env.AI.run.await_count == 0


async def test_progress_is_sent_to_workspace_and_other_channels_cannot_resolve(app, interaction):
    row = await workspace(app, interaction)
    await app.db.run("UPDATE build_requests SET remote_status = 'building' WHERE id = ?", row["id"])
    app.transport.calls.clear()
    await app.builds.reconcile(app.discord)
    assert any(f"/channels/{row['thread_id']}/messages" in u for u, _ in app.transport.calls)
    assert (
        await app.builds.in_thread(
            BuildScope(row["guild_id"], "999999999999999999", row["requester_user_id"])
        )
        is None
    )
    assert (
        await app.builds.status(
            BuildScope("999999999999999999", row["thread_id"], row["requester_user_id"]), row["id"]
        )
        is None
    )
