import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest


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


@pytest.mark.parametrize("supported", [True, False])
async def test_responses_chat_preserves_conversation_and_extracts_reply(app, supported):
    from ragbot.ai import Attribution
    from ragbot.config import ModelConfig

    app.env.AI = SimpleNamespace(
        run=AsyncMock(
            return_value={
                "output": [
                    {"type": "message", "content": [{"type": "output_text", "text": "Hello"}]}
                ],
                "usage": {"input_tokens": 10, "output_tokens": 3, "total_tokens": 13},
            }
        )
    )
    config = ModelConfig(
        "openai/example-responses",
        "system",
        1000,
        0.7,
        "test",
        api_format="responses",
        temperature_supported=supported,
    )
    messages = [{"role": "system", "content": "system"}, {"role": "user", "content": "hello"}]
    result = await app.ai.chat(config, messages, Attribution("channel_reply"))
    assert result.content == "Hello" and result.usage["total_tokens"] == 13
    model, request, options = app.env.AI.run.call_args.args
    assert model == config.model and request == {
        "input": messages,
        "max_output_tokens": 1000,
        **({"temperature": 0.7} if supported else {}),
    }
    assert options["gateway"]["id"] == "test"


async def test_reasoning_chat_uses_completion_token_limit_without_temperature(app):
    from ragbot.ai import Attribution
    from ragbot.config import ModelConfig

    config = ModelConfig("openai/gpt-5", "system", 2000, 0.7, "test")
    await app.ai.chat(config, [{"role": "user", "content": "hello"}], Attribution("channel_reply"))
    body = json.loads(
        next(
            options["body"]
            for url, options in app.transport.calls
            if "gateway.ai.cloudflare.com" in url
        )
    )
    assert body["max_completion_tokens"] == 2000
    assert "max_tokens" not in body and "temperature" not in body
