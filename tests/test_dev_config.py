"""Dev overrides use the same config resolution as real command handlers."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from ragbot._bundled import FILES
from ragbot.ai import Attribution
from ragbot.commands.media import bicture
from ragbot.config import ConfigStore
from ragbot.settings import DraftNamespace as ConfigNamespace
from ragbot.settings import resolve_config


async def test_dev_chat_prompts_and_models_are_isolated():
    defaults = await resolve_config({})
    custom = await resolve_config(
        {
            "model": "example/chat",
            "systemPrompt": "Answer in haiku.",
            "webSearchModel": "example/search",
            "webSearchSystemPrompt": "Cite sources.",
            "temperature": 0,
            "historyLimit": 6,
        }
    )
    assert custom["responseModel"] == "example/chat"
    assert custom["systemPrompt"] == "Answer in haiku."
    assert custom["askWebSearchModel"] == "example/search"
    assert custom["askWebSearchSystemPrompt"] == "Cite sources."
    assert custom["temperature"] == 0
    assert custom["historyLimit"] == 6
    assert await resolve_config({}) == defaults


async def test_dev_image_profile_reaches_real_command(app):
    original = json.loads(FILES["bicture-image.json"])
    app.config = ConfigStore(
        SimpleNamespace(
            AI_CONFIG=ConfigNamespace(
                {"imageProfile": "quality", "imageAspectRatio": "1:1", "imageModel": "test/image"}
            )
        )
    )
    app.ai.media = AsyncMock(return_value={"data": [{"b64_json": "YWJj"}]})
    ctx = SimpleNamespace(
        app=app,
        option=lambda name: "a tree",
        attribution=lambda kind: Attribution(kind),
        reply=AsyncMock(return_value=True),
    )
    await bicture(ctx)
    profile, request, _ = app.ai.media.call_args.args
    assert profile["model"] == "test/image"
    assert request["prompt"] == "a tree"
    assert request["aspect_ratio"] == "1:1"
    assert request["resolution"] == original["profiles"]["quality"]["resolution"]
    assert ctx.reply.call_args.kwargs["files"][0].data == b"abc"
    assert (await resolve_config({}))["image"] == original


async def test_unknown_image_profile_is_rejected():
    with pytest.raises(ValueError, match="unknown image profile"):
        await resolve_config({"imageProfile": "missing"})


async def test_reasoning_is_preserved_for_same_model_and_cleared_on_model_change():
    resources = dict(FILES)
    document = json.loads(resources["discord-response.json"])
    document.update(model="grok/grok-4.6", reasoningEffort="low")
    resources["discord-response.json"] = json.dumps(document)
    assert (await resolve_config({}, resources))["chatReasoningEffort"] == "low"
    assert (await resolve_config({"temperature": 0.5}, resources))["chatReasoningEffort"] == "low"
    assert (await resolve_config({"model": "grok/grok-4.6"}, resources))[
        "chatReasoningEffort"
    ] == "low"
    changed = await resolve_config({"model": "openai/gpt-4.1-mini"}, resources)
    assert changed["chatReasoningEffort"] is None


async def test_grok_draft_simulation_uses_binding_and_leaves_saved_settings_unchanged(app):
    from harness import Simulation

    upstream = AsyncMock(side_effect=AssertionError("unexpected external HTTP request"))
    simulation = Simulation(
        app.env,
        {
            "identity": {"userId": "123456789012345679", "username": "tester"},
            "channelId": "123456789012345681",
            "guildId": app.env.ALLOWED_GUILD_IDS,
            "botUserId": app.env.DISCORD_APPLICATION_ID,
            "content": "hello",
            "baseResources": FILES,
            "settingsRevision": "saved-revision",
            "overrides": {"model": "grok/grok-4.7", "temperature": 0.9},
        },
        upstream=upstream,
    )
    result = await simulation.run("mention")
    assert result["db"]["interaction"]["status"] == "ok"
    assert result["replies"][0]["content"] == "hello <https://example.com>"
    assert len(result["ai"]) == 1
    exchange = result["ai"][0]
    assert exchange["transport"] == "workers-ai-binding"
    assert exchange["model"] == "xai/grok-4.7"
    assert exchange["settingsRevision"].startswith("saved-revision+draft-")
    assert exchange["request"]["options"]["gateway"]["metadata"]["ragbot_env"] == "dev"
    assert not await app.db.all("SELECT * FROM ai_runtime_settings")
    upstream.assert_not_awaited()
