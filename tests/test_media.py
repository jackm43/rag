from types import SimpleNamespace


async def test_bicture_reports_rejected_upload_without_regenerating(app):
    from unittest.mock import AsyncMock

    from ragbot.commands.media import bicture

    app.ai.media = AsyncMock(return_value={"data": [{"b64_json": "YWJj"}]})
    ctx = SimpleNamespace(
        app=app,
        option=lambda name: "a tree",
        attribution=lambda kind: None,
        reply=AsyncMock(side_effect=[False, True]),
    )
    await bicture(ctx)
    app.ai.media.assert_awaited_once()
    assert ctx.reply.await_count == 2
    uploaded = ctx.reply.await_args_list[0].kwargs["files"][0]
    assert uploaded.data == b"abc"
    assert "Discord rejected the upload" in ctx.reply.await_args_list[1].args[0]
    assert not ctx.reply.await_args_list[1].kwargs
