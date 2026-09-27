from types import SimpleNamespace

from ragbot.ai import Attribution


async def test_bicture_reports_rejected_upload_without_regenerating(app):
    from unittest.mock import AsyncMock

    from ragbot.commands.media import bicture

    app.ai.media = AsyncMock(return_value={"data": [{"b64_json": "YWJj"}]})
    ctx = SimpleNamespace(
        app=app,
        option=lambda name: "a tree",
        attribution=lambda kind: Attribution(kind),
        reply=AsyncMock(side_effect=[False, True]),
    )
    await bicture(ctx)
    app.ai.media.assert_awaited_once()
    assert ctx.reply.await_count == 2
    uploaded = ctx.reply.await_args_list[0].kwargs["files"][0]
    assert uploaded.data == b"abc"
    assert "Discord rejected the upload" in ctx.reply.await_args_list[1].args[0]
    assert not ctx.reply.await_args_list[1].kwargs
    recorded = await app.db.first("SELECT status, error_message FROM rag_ai_interactions")
    assert recorded == {"status": "error", "error_message": "DiscordUploadRejected"}


async def test_bicture_records_full_prompt_and_generation_failure(app):
    from unittest.mock import AsyncMock

    from ragbot.commands.media import bicture

    prompt = "a detailed tree " * 60
    app.ai.media = AsyncMock(return_value={"data": [{"b64_json": "YWJj"}]})
    ctx = SimpleNamespace(
        app=app,
        option=lambda name: prompt,
        attribution=lambda kind: Attribution(kind, "user", "tester", "channel", "message"),
        reply=AsyncMock(return_value=True),
    )
    await bicture(ctx)
    row = await app.db.first("SELECT * FROM rag_ai_interactions")
    assert row["prompt"] == prompt and row["kind"] == "bicture"
    assert row["status"] == "ok" and row["model"] != "unknown"
    assert row["channel_id"] == "channel" and row["requester_username"] == "tester"
    assert row["response_text"] is None
    app.ai.media.side_effect = RuntimeError("private provider details")
    await bicture(ctx)
    row = await app.db.first("SELECT * FROM rag_ai_interactions ORDER BY id DESC LIMIT 1")
    assert row["prompt"] == prompt and row["status"] == "error"
    assert row["error_message"] == "RuntimeError"


async def test_bicture_history_failure_does_not_repeat_generation_or_reply(app):
    from unittest.mock import AsyncMock

    from ragbot.commands.media import bicture

    app.ai.media = AsyncMock(return_value={"data": [{"b64_json": "YWJj"}]})
    app.db = SimpleNamespace(run=AsyncMock(side_effect=RuntimeError("D1 unavailable")))
    ctx = SimpleNamespace(
        app=app,
        option=lambda name: "a tree",
        attribution=lambda kind: Attribution(kind),
        reply=AsyncMock(return_value=True),
    )
    await bicture(ctx)
    app.ai.media.assert_awaited_once()
    ctx.reply.assert_awaited_once()
