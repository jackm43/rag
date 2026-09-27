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
    app.env.AI.run.return_value = {"output_text": "Clear skies", "output": []}
    message["content"] = "weather today"
    await app.handle_message(message, app.env.DISCORD_APPLICATION_ID)
    chat_model, chat_request, _ = app.env.AI.run.await_args_list[0].args
    assert chat_model == "xai/grok-4.3"
    assert "messages" in chat_request and "web_search_options" not in chat_request
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
        **({"temperature": 0.7} if supported else {}),
    }
    assert options["gateway"]["id"] == "test"


async def test_reasoning_chat_omits_token_limit_and_temperature(app):
    from ragbot.ai import Attribution
    from ragbot.config import ModelConfig

    config = ModelConfig("openai/gpt-5", "system", 2000, 0.7, "test")
    await app.ai.chat(config, [{"role": "user", "content": "hello"}], Attribution("channel_reply"))
    model, body, options = app.env.AI.run.call_args.args
    assert model == "openai/gpt-5" and options["gateway"]["id"] == "test"
    assert body == {"messages": [{"role": "user", "content": "hello"}]}


@pytest.mark.parametrize(
    ("model", "catalog_model"),
    [
        ("grok/grok-4.3", "xai/grok-4.3"),
        ("grok/grok-4.7", "xai/grok-4.7"),
        ("xai/grok-4.7", "xai/grok-4.7"),
        ("google-ai-studio/gemini-2.5-flash", "google/gemini-2.5-flash"),
        ("google/gemini-2.5-flash", "google/gemini-2.5-flash"),
        ("openai/gpt-4.1-mini", "openai/gpt-4.1-mini"),
        ("anthropic/claude-sonnet-4-5", "anthropic/claude-sonnet-4-5"),
        ("new-provider/new-model", "new-provider/new-model"),
        ("workers-ai/@cf/example/model", "@cf/example/model"),
    ],
)
async def test_chat_uses_catalog_billing_route_and_preserves_settings(app, model, catalog_model):
    from ragbot.ai import Attribution
    from ragbot.config import ModelConfig

    app.env.AI = SimpleNamespace(
        run=AsyncMock(
            return_value={
                "choices": [{"message": {"content": "Hello"}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13},
            }
        )
    )
    config = ModelConfig(model, "system", 1000, 0.9, "platy", revision="saved-revision")
    messages = [{"role": "system", "content": "system"}, {"role": "user", "content": "hello"}]
    result = await app.ai.chat(config, messages, Attribution("channel_reply", user_id="test-user"))

    assert result.content == "Hello" and result.usage["total_tokens"] == 13
    app.env.AI.run.assert_awaited_once()
    routed_model, request, options = app.env.AI.run.call_args.args
    assert routed_model == catalog_model
    assert request == {"messages": messages, "temperature": 0.9}
    assert options["gateway"]["id"] == "platy"
    assert options["gateway"]["metadata"]["ragbot_settings_revision"] == "saved-revision"
    assert options["gateway"]["metadata"]["discord_user_id"] == "test-user"
    assert not app.transport.calls


async def test_grok_binding_failure_is_not_retried_via_legacy_gateway(app):
    from ragbot.ai import Attribution
    from ragbot.config import ModelConfig

    app.env.AI = SimpleNamespace(run=AsyncMock(side_effect=RuntimeError("provider failure")))
    with pytest.raises(RuntimeError):
        await app.ai.chat(
            ModelConfig("grok/grok-4.7", "system", 1000, 0.9, "platy"),
            [{"role": "user", "content": "hello"}],
            Attribution("channel_reply"),
        )
    app.env.AI.run.assert_awaited_once()
    assert not app.transport.calls


@pytest.mark.parametrize("api_format", ["chat-completions", "responses"])
async def test_low_reasoning_reaches_ai_without_reintroducing_token_limit(app, api_format):
    from ragbot.ai import Attribution
    from ragbot.config import ModelConfig

    await app.ai.chat(
        ModelConfig(
            "grok/grok-4.6",
            "system",
            None,
            0.9,
            "platy",
            api_format=api_format,
            reasoning_effort="low",
        ),
        [{"role": "user", "content": "hello"}],
        Attribution("channel_reply"),
    )
    model, body, _ = app.env.AI.run.call_args.args
    assert model == "xai/grok-4.6"
    if api_format == "responses":
        assert body["reasoning"] == {"effort": "low"}
        assert "reasoning_effort" not in body
    else:
        assert body["reasoning_effort"] == "low"
        assert "reasoning" not in body
    assert not {"max_tokens", "max_completion_tokens", "max_output_tokens"} & body.keys()
