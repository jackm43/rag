from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from conftest import FakeResponse

from ragbot.builds import BuildScope

GUILD = "457689460096630794"
OWNER = "123456789012345679"
OTHER = "999999999999999999"
MODS = "457695154892177418"
THREAD = "123456789012345690"


def connect(app, **views):
    """Enable a fake builder whose methods return the given views."""
    view = {"status": "queued", "revision": 1, "releases": []}
    app.env.BUILDER_ENABLED = "true"
    app.env.BUILDER = SimpleNamespace(
        **{
            name: AsyncMock(return_value=views.get(name, view))
            for name in ("submit", "status", "edit", "cancel", "rollback", "delete")
        }
    )
    return app.env.BUILDER


def build(interaction, prompt="a shared drawing game", **kwargs):
    return interaction("build", options=[{"name": "prompt", "value": prompt}], **kwargs)


async def rows(app):
    return await app.db.all("SELECT * FROM build_requests")


def mention(app, row, content, *, author=OWNER, roles=()):
    return {
        "id": "123456789012345799",
        "guild_id": GUILD,
        "channel_id": row["thread_id"],
        "author": {"id": author, "username": "member"},
        "member": {"roles": list(roles)},
        "content": f"<@{app.env.DISCORD_APPLICATION_ID}> {content}",
    }


async def test_intake_is_durable_idempotent_and_opens_one_workspace(app, interaction):
    builder = connect(app)
    await app.dispatch(build(interaction))
    await app.dispatch(build(interaction))
    [row] = await rows(app)
    assert (row["prompt"], row["status"], row["thread_id"]) == (
        "a shared drawing game",
        "queued",
        THREAD,
    )
    payload = builder.submit.call_args.args[0]
    assert payload == {
        "id": row["id"],
        "guild_id": GUILD,
        "channel_id": row["channel_id"],
        "user_id": OWNER,
        "moderator": False,
        "prompt": "a shared drawing game",
    }
    assert len([u for u, _ in app.transport.calls if u.endswith("/threads")]) == 1
    assert app.transport.writes()[-1]["content"] == f"On it! Follow along in <#{THREAD}>."
    assert app.transport.writes()[-1]["allowed_mentions"] == {"parse": []}
    assert app.env.AI.run.await_count == 0


@pytest.mark.parametrize("case", ["dm", "other_guild", "unset", "missing_member"])
async def test_intake_needs_a_configured_guild_member(app, interaction, case):
    request = build(interaction)
    if case == "dm":
        request["guild_id"] = None
    elif case == "other_guild":
        request["guild_id"] = OTHER
    elif case == "unset":
        app.env.ALLOWED_GUILD_IDS = ""
    else:
        request["user"] = request.pop("member")["user"]
    await app.dispatch(request)
    assert not await rows(app)
    assert app.transport.writes()[-1]["content"] in (
        "App builds are only available in this server's channels.",
        "This bot only works in its home server.",
    )


async def test_requests_wait_for_the_builder_and_start_from_the_cron(app, interaction):
    await app.dispatch(build(interaction))
    [row] = await rows(app)
    assert row["status"] == "submitted"
    builder = connect(app)
    builder.submit.side_effect = RuntimeError("private detail")
    await app.builds.reconcile(app.discord)
    assert (await rows(app))[0]["status"] == "submitted"
    builder.submit.side_effect = None
    await app.builds.reconcile(app.discord)
    assert (await rows(app))[0]["status"] == "queued"
    assert all("private detail" not in w.get("content", "") for w in app.transport.writes())


async def test_results_are_announced_once_through_the_reply_policy(app, interaction):
    builder = connect(app)
    await app.dispatch(build(interaction))
    builder.status.return_value = {
        "status": "ready",
        "revision": 1,
        "active": 1,
        "url": "https://apps.example.com/drawing-1234/",
        "title": "Doodle <@123456789012345678> Duel",
        "summary": "Built Doodle Duel: draw together! @everyone https://evil.example",
    }
    await app.builds.reconcile(app.discord)
    await app.builds.reconcile(app.discord)
    results = [w["content"] for w in app.transport.writes() if "is ready" in w.get("content", "")]
    assert len(results) == 1
    assert results[0].startswith(
        "**Doodle Duel** is ready: <https://apps.example.com/drawing-1234/>"
    )
    assert "Built Doodle Duel: draw together! everyone <https://evil.example>" in results[0]


async def test_failed_revisions_keep_the_previous_release(app, interaction):
    builder = connect(app)
    await app.dispatch(build(interaction))
    await app.db.run("UPDATE build_requests SET revision = 2, announced_revision = 1")
    builder.status.return_value = {
        "status": "failed",
        "revision": 2,
        "active": 1,
        "error": "tests_failed",
        "url": "https://apps.example.com/drawing-1234/",
    }
    await app.builds.reconcile(app.discord)
    text = app.transport.writes()[-1]["content"]
    assert "the app's tests failed" in text
    assert "previous version is still live: <https://apps.example.com/drawing-1234/>" in text


async def test_lookups_stay_in_the_origin_channel_or_workspace(app, interaction):
    connect(app)
    await app.dispatch(build(interaction, prompt="private idea"))
    [row] = await rows(app)
    here = BuildScope(GUILD, row["channel_id"], OWNER)
    assert await app.builds.find(here, row["id"])
    assert await app.builds.find(BuildScope(GUILD, THREAD, OTHER), row["id"])
    assert await app.builds.find(BuildScope(GUILD, OTHER, OWNER), row["id"]) is None
    assert await app.builds.find(BuildScope(OTHER, row["channel_id"], OWNER), row["id"]) is None
    request = interaction("buildstatus", options=[{"name": "request", "value": row["id"]}])
    request["channel_id"] = OTHER
    await app.dispatch(request)
    assert "workspace thread" in app.transport.writes()[-1]["content"]


async def test_replayed_source_cannot_change_prompt_or_scope(app, interaction):
    request = build(interaction, prompt="original")
    await app.dispatch(request)
    request["data"]["options"][0]["value"] = "replacement"
    request["channel_id"] = OTHER
    await app.dispatch(request)
    assert app.transport.writes()[-1]["content"] == "Command failed. Try again."
    assert [r["prompt"] for r in await rows(app)] == ["original"]


async def test_database_failure_cannot_report_saved(app, interaction):
    app.db.run = AsyncMock(side_effect=RuntimeError("sensitive database error"))
    await app.dispatch(build(interaction))
    assert app.transport.writes()[-1]["content"] == "Command failed. Try again."


async def test_ambiguous_thread_creation_is_not_retried(app, interaction):
    app.discord.create_thread = AsyncMock(side_effect=RuntimeError("lost response"))
    await app.dispatch(build(interaction))
    await app.dispatch(build(interaction))
    app.discord.create_thread.assert_awaited_once()
    assert (await rows(app))[0]["thread_id"] is None


async def test_private_channels_and_threads_get_no_public_workspace(app, interaction):
    app.transport.handler = lambda url, opts: (
        FakeResponse({"type": 12}) if url.endswith("/channels/123456789012345681") else None
    )
    await app.dispatch(build(interaction))
    assert not any(u.endswith("/threads") for u, _ in app.transport.calls)


async def test_build_mention_starts_an_app_without_chat(app):
    connect(app)
    message = {
        "id": "123456789012345799",
        "guild_id": GUILD,
        "channel_id": "123456789012345681",
        "author": {"id": OWNER, "username": "user", "global_name": "Player One"},
        "content": f"<@{app.env.DISCORD_APPLICATION_ID}> build a three.js galaxy we can fly through",
    }
    await app.handle_message(message, app.env.DISCORD_APPLICATION_ID)
    [row] = await rows(app)
    assert row["prompt"] == "a three.js galaxy we can fly through"
    assert "Building this for Player One" in app.transport.writes()[-2]["content"]
    assert app.transport.writes()[-1]["message_reference"]["message_id"] == message["id"]
    assert app.env.AI.run.await_count == 0


async def test_other_mentions_outside_workspaces_are_still_chat(app):
    message = {
        "id": "123456789012345799",
        "guild_id": GUILD,
        "channel_id": "123456789012345681",
        "author": {"id": OWNER, "username": "user"},
        "content": f"<@{app.env.DISCORD_APPLICATION_ID}> what should we build?",
    }
    await app.handle_message(message, app.env.DISCORD_APPLICATION_ID)
    assert not await rows(app)
    assert app.env.AI.run.await_count == 1


@pytest.mark.parametrize("mode", ["owner", "moderator", "member", "status", "discussion"])
async def test_workspace_mentions_request_changes(app, interaction, mode):
    builder = connect(app, edit={"status": "queued", "revision": 2, "releases": [1]})
    await app.dispatch(build(interaction))
    [row] = await rows(app)
    content = {"status": "status", "discussion": "fix the keyboard"}.get(mode, "fix the keyboard")
    message = mention(
        app,
        row,
        content,
        author=OWNER if mode in ("owner", "status") else OTHER,
        roles=[MODS] if mode == "moderator" else [],
    )
    if mode == "discussion":
        message["content"] = "I like this game"
    await app.handle_message(message, app.env.DISCORD_APPLICATION_ID)
    if mode in ("owner", "moderator"):
        payload = builder.edit.call_args.args[0]
        assert payload["prompt"] == "fix the keyboard"
        assert payload["operation"] == message["id"]
        assert payload["channel_id"] == row["channel_id"]
        assert payload["moderator"] is (mode == "moderator")
        assert "revision 2" in app.transport.writes()[-1]["content"]
    else:
        builder.edit.assert_not_called()
    if mode == "member":
        assert "owner or Mods" in app.transport.writes()[-1]["content"]
    if mode == "status":
        assert "Build `" in app.transport.writes()[-1]["content"]
    assert app.env.AI.run.await_count == 0


@pytest.mark.parametrize(
    "command,options,method,expected",
    [
        ("buildedit", [{"name": "prompt", "value": "add sound"}], "edit", {"prompt": "add sound"}),
        ("buildcancel", [], "cancel", {}),
        ("buildrollback", [{"name": "revision", "value": "1"}], "rollback", {"revision": 1}),
        ("builddelete", [], "delete", {}),
        ("buildstatus", [], "status", {}),
    ],
)
async def test_workspace_commands_infer_the_app(
    app, interaction, command, options, method, expected
):
    builder = connect(app)
    await app.dispatch(build(interaction))
    [row] = await rows(app)
    request = interaction(command, options=options)
    request["channel_id"] = THREAD
    request["id"] = "123456789012345798"
    await app.dispatch(request)
    payload = getattr(builder, method).call_args.args[0]
    assert payload["id"] == row["id"] and payload["channel_id"] == row["channel_id"]
    assert expected.items() <= payload.items()


async def test_only_owner_or_mods_manage_apps(app, interaction):
    builder = connect(app)
    await app.dispatch(build(interaction))
    [row] = await rows(app)
    option = [{"name": "request", "value": row["id"]}]
    await app.dispatch(interaction("builddelete", user=OTHER, options=option))
    builder.delete.assert_not_called()
    assert "owner or Mods" in app.transport.writes()[-1]["content"]
    await app.dispatch(interaction("builddelete", user=OTHER, roles=[MODS], options=option))
    assert builder.delete.call_args.args[0]["moderator"] is True
    await app.dispatch(
        interaction("buildrollback", options=[{"name": "revision", "value": "x"}, *option])
    )
    assert "revision number" in app.transport.writes()[-1]["content"]


async def test_deleted_apps_do_not_take_changes(app, interaction):
    builder = connect(app, delete={"status": "deleted", "revision": 1, "releases": [1]})
    await app.dispatch(build(interaction))
    [row] = await rows(app)
    await app.dispatch(
        interaction("builddelete", options=[{"name": "request", "value": row["id"]}])
    )
    row = (await rows(app))[0]
    assert (row["status"], row["prompt"]) == ("deleted", "[deleted]")
    await app.handle_message(mention(app, row, "bring it back"), app.env.DISCORD_APPLICATION_ID)
    builder.edit.assert_not_called()
    assert "was deleted" in app.transport.writes()[-1]["content"]
