from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest


async def test_time_sensitive_mentions_use_chat_without_tools(app):
    from test_conversation import BOT, message

    await app.handle_message(message(1, f"<@{BOT}> what is the weather today?"), BOT)
    app.env.AI.run.assert_awaited_once()
    model, request, _ = app.env.AI.run.call_args.args
    assert model == "xai/grok-4.3"
    assert set(request) == {"messages", "temperature"}
    assert "weather today" in request["messages"][-1]["content"]


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

    config = ModelConfig("openai/gpt-5", "system", 0.7, "test")
    await app.ai.chat(config, [{"role": "user", "content": "hello"}], Attribution("channel_reply"))
    model, body, options = app.env.AI.run.call_args.args
    assert model == "openai/gpt-5" and options["gateway"]["id"] == "test"
    assert body == {"messages": [{"role": "user", "content": "hello"}]}


@pytest.mark.parametrize(
    ("model", "catalog_model"),
    [
        ("xai/grok-4.3", "xai/grok-4.3"),
        ("xai/grok-4.7", "xai/grok-4.7"),
        ("google/gemini-2.5-flash", "google/gemini-2.5-flash"),
        ("openai/gpt-4.1-mini", "openai/gpt-4.1-mini"),
        ("anthropic/claude-sonnet-4-5", "anthropic/claude-sonnet-4-5"),
        ("new-provider/new-model", "new-provider/new-model"),
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
    config = ModelConfig(model, "system", 0.9, "platy", revision="saved-revision")
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


async def test_binding_failure_is_not_retried(app):
    from ragbot.ai import Attribution
    from ragbot.config import ModelConfig

    app.env.AI = SimpleNamespace(run=AsyncMock(side_effect=RuntimeError("provider failure")))
    with pytest.raises(RuntimeError):
        await app.ai.chat(
            ModelConfig("xai/grok-4.7", "system", 0.9, "platy"),
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
            "xai/grok-4.6",
            "system",
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
