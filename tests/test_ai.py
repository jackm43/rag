import json
from types import SimpleNamespace
from unittest.mock import AsyncMock


async def test_mention_and_ask_thread_use_shared_router(app):
    message = {
        "id": "123456789012345680",
        "channel_id": "123456789012345681",
        "guild_id": "457689460096630794",
        "author": {"id": "123456789012345679", "username": "tester"},
        "content": "hello",
    }
    await app.handle_message(message, app.env.DISCORD_APPLICATION_ID)
    assert not app.transport.calls
    message["content"] = f"<@{app.env.DISCORD_APPLICATION_ID}> hello"
    await app.handle_message(message, app.env.DISCORD_APPLICATION_ID)
    assert (await app.db.all("SELECT * FROM rag_ai_interactions"))[0]["kind"] == "channel_reply"
    await app.db.record_thread(
        {
            "thread_id": message["channel_id"],
            "initial_prompt": "hello",
            "title": "hello",
            "requester_username": "tester",
        }
    )
    app.env.AI = SimpleNamespace(
        run=AsyncMock(return_value={"output_text": "Clear skies", "output": []})
    )
    message["content"] = "weather today"
    await app.handle_message(message, app.env.DISCORD_APPLICATION_ID)
    ai_calls = [
        json.loads(options["body"])
        for url, options in app.transport.calls
        if "gateway.ai.cloudflare.com" in url
    ]
    assert "web_search_options" not in ai_calls[0]
    model, request, options = app.env.AI.run.call_args.args
    assert model == "openai/gpt-4.1-mini"
    assert request["tools"] == [{"type": "web_search_preview", "search_context_size": "medium"}]
    assert "weather today" in request["input"]
    assert options["gateway"]["id"] == "platy"
    assert any(
        "Clear skies" in str(options.get("body", ""))
        for url, options in app.transport.calls
        if "discord.com" in url
    )
