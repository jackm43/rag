import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from conftest import SQLiteBinding
from settings_api import SettingsEditor, SettingsError
from settings_seed import SETTINGS_KEY, legacy_resources, load_resources

from ragbot.config import ConfigStore
from ragbot.settings_storage import READ_SETTINGS, WRITE_SETTINGS

FILES = load_resources()


class MemoryKV:
    def __init__(self):
        self.values = {}
        self.db = SQLiteBinding(settings=True)

    async def get(self, key):
        return self.values.get(key)

    async def put(self, key, value):
        self.values[key] = value


def editor(kv, **kwargs):
    async def available(config, groups):
        return {
            "chat": [
                {
                    "id": config["responseModel"],
                    "apiFormat": "chat-completions",
                    "temperature": {"minimum": 0, "maximum": 2},
                }
            ]
        }

    catalog = SimpleNamespace(validate=AsyncMock(side_effect=available))
    return SettingsEditor(
        SimpleNamespace(AI_CONFIG=kv, DB=kv.db),
        "local",
        destination={"worker": "test"},
        catalog=catalog,
        **kwargs,
    )


async def test_save_refreshes_existing_production_store_without_redeploy():
    kv = MemoryKV()
    store = ConfigStore(SimpleNamespace(AI_CONFIG=kv, DB=kv.db))
    old_chat, _ = await store.models()
    ui = editor(kv)
    before = await ui.read()
    body = {
        "page": "chat",
        "baseRevision": before["revision"],
        "overrides": {"systemPrompt": "Reply briefly.", "temperature": 0.2},
    }
    body["reviewId"] = (await ui.preview(body))["reviewId"]
    saved = await ui.save(body)
    assert saved["source"] == "d1"
    assert not kv.values  # KV is never written by the new editor.
    chat, search = await store.models()  # No timer change or new application.
    assert chat.prompt == "Reply briefly." and chat.prompt != old_chat.prompt
    assert chat.temperature == 0.2
    assert chat.revision == search.revision == saved["revision"]
    assert search.prompt == before["config"]["askWebSearchSystemPrompt"]
    assert (await ui.read())["revision"] == saved["revision"]
    # Invalid current data must never silently serve a stale cached configuration.
    kv.db.connection.execute("UPDATE ai_runtime_settings SET document = '{}' WHERE id = 1")
    with pytest.raises(ValueError):
        await store.models()


async def test_legacy_chat_token_limit_is_ignored_and_removed_on_save():
    kv = MemoryKV()
    legacy = json.loads(FILES["discord-response.json"]) | {"maxTokens": 1000}
    resources = dict(FILES)
    resources["discord-response.json"] = json.dumps(legacy)
    await editor(kv).write(resources, "test-seed")
    store = ConfigStore(SimpleNamespace(AI_CONFIG=kv, DB=kv.db))
    chat, search = await store.models()
    assert chat.max_tokens is None
    assert search.max_tokens == 1200
    ui = editor(kv)
    before = await ui.read()
    assert "maxTokens" not in before["config"]
    body = {
        "page": "chat",
        "baseRevision": before["revision"],
        "overrides": {"temperature": 0.4},
    }
    body["reviewId"] = (await ui.preview(body))["reviewId"]
    saved = await ui.save(body)
    assert "maxTokens" not in json.loads(saved["resources"]["discord-response.json"])
    assert json.loads(saved["resources"]["ask-web-search.json"]) == json.loads(
        before["resources"]["ask-web-search.json"]
    )
    assert (await store.models())[0].max_tokens is None


async def test_conditional_database_writes_reject_a_concurrent_editor():
    kv = MemoryKV()
    first, second = editor(kv), editor(kv)
    current = await first.read()
    a, b = dict(current["resources"]), dict(current["resources"])
    a["discord-response-system-prompt.md"] = "Editor A"
    b["discord-response-system-prompt.md"] = "Editor B"
    results = await asyncio.gather(
        first.write(a, current["revision"]),
        second.write(b, current["revision"]),
        return_exceptions=True,
    )
    assert sum(isinstance(result, SettingsError) for result in results) == 1
    winner = next(result for result in results if isinstance(result, dict))
    assert (await first.read())["resources"] == winner["resources"]


async def test_operator_migration_preserves_legacy_prompt():
    kv = MemoryKV()
    resources = dict(FILES)
    resources["discord-response-system-prompt.md"] = "Preserved live prompt"
    kv.values[SETTINGS_KEY] = json.dumps(
        {"schemaVersion": 1, "resources": resources, "revision": "old-kv"}
    )
    assert await legacy_resources(kv.get) == resources
    kv.values = {"discord-response-system-prompt.md": "Individual legacy prompt"}
    assert (await legacy_resources(kv.get))[
        "discord-response-system-prompt.md"
    ] == "Individual legacy prompt"


async def test_primary_read_failure_stops_inference_instead_of_using_old_settings(app):
    await app.config.models()
    app.env.DB.prepare = lambda _: (_ for _ in ()).throw(RuntimeError("unavailable"))
    with pytest.raises(RuntimeError):
        await app.ai.ask("Hello", "user", [], SimpleNamespace())
    assert not app.transport.calls


@pytest.mark.parametrize("database", [None, "empty"])
async def test_uninitialized_settings_never_use_kv_or_call_ai(app, database):
    kv = SimpleNamespace(get=AsyncMock(side_effect=AssertionError("KV fallback is forbidden")))
    app.env.AI_CONFIG = kv
    app.env.DB = SQLiteBinding() if database == "empty" else None
    with pytest.raises(ValueError, match="D1"):
        await app.ai.ask("Hello", "user", [], SimpleNamespace())
    kv.get.assert_not_awaited()
    app.env.AI.run.assert_not_awaited()
    assert not app.transport.calls


async def test_editor_requires_initialized_d1_even_with_legacy_kv():
    kv = MemoryKV()
    kv.db = SQLiteBinding()
    kv.values = dict(FILES)
    with pytest.raises(SettingsError, match="not initialized"):
        await editor(kv).read()
    assert not kv.db.connection.execute("SELECT * FROM ai_runtime_settings").fetchall()


@pytest.mark.parametrize("model", [None, "", 123])
async def test_invalid_saved_model_has_no_packaged_default(model):
    kv = MemoryKV()
    resources = dict(FILES)
    resources["discord-response.json"] = json.dumps({"model": model})
    with pytest.raises(ValueError, match="missing settings model"):
        await editor(kv).write(resources, "test-seed")


async def test_saved_documents_do_not_merge_file_defaults():
    kv = MemoryKV()
    resources = dict(FILES)
    resources["discord-response.json"] = json.dumps({"model": "example/chat"})
    await editor(kv).write(resources, "test-seed")
    store = ConfigStore(SimpleNamespace(DB=kv.db))
    assert await store.document("discord-response.json") == {"model": "example/chat"}


async def test_models_are_one_coherent_snapshot_from_one_query():
    kv = MemoryKV()
    saved = await editor(kv).read()
    calls = []
    prepare = kv.db.prepare

    def record(sql):
        calls.append(sql)
        return prepare(sql)

    kv.db.prepare = record
    store = ConfigStore(SimpleNamespace(DB=kv.db))
    chat, search = await store.models()
    assert calls == [READ_SETTINGS]
    assert chat.revision == search.revision == saved["revision"]
    newer = dict(saved["resources"])
    newer["discord-response-system-prompt.md"] = "New prompt"
    await editor(kv).write(newer, saved["revision"])
    assert chat.prompt != (await store.models())[0].prompt


async def test_stale_or_altered_review_cannot_overwrite_saved_settings():
    kv = MemoryKV()
    ui = editor(kv)
    before = await ui.read()
    body = {
        "page": "chat",
        "baseRevision": before["revision"],
        "overrides": {"systemPrompt": "First"},
    }
    review = await ui.preview(body)
    body["reviewId"] = review["reviewId"]
    body["overrides"]["systemPrompt"] = "Altered"
    with pytest.raises(SettingsError, match="Review these exact settings"):
        await ui.save(body)
    assert not kv.values
    body["overrides"]["systemPrompt"] = "First"
    await ui.save(body)
    with pytest.raises(SettingsError, match="Settings changed"):
        await ui.save(body)


@pytest.mark.parametrize(
    "overrides",
    [
        {"kv": {"other": "data"}},
        {"maxTokens": -1},
        {"temperature": float("nan")},
        {"historyLimit": 1.5},
    ],
)
async def test_invalid_settings_never_write(overrides):
    kv = MemoryKV()
    ui = editor(kv)
    before = await ui.read()
    with pytest.raises(ValueError):
        await ui.preview(
            {"page": "chat", "baseRevision": before["revision"], "overrides": overrides}
        )
    assert not kv.values


async def test_remote_failure_does_not_report_success_or_allow_other_queries():
    transport = AsyncMock(return_value=SimpleNamespace(ok=False, status=403))
    ui = SettingsEditor(
        SimpleNamespace(CLOUDFLARE_API_TOKEN="test"),
        "live",
        destination={
            "worker": "test",
            "account": "a" * 32,
            "database": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        },
        transport=transport,
    )
    with pytest.raises(SettingsError, match="permissions"):
        await ui.query(WRITE_SETTINGS, ("revision", "{}", None))
    assert transport.call_args.kwargs["method"] == "POST"
    with pytest.raises(SettingsError, match="Invalid settings query"):
        await ui.query("DELETE FROM rag_counts")
    assert transport.call_count == 1


async def test_saved_image_parameters_reach_shared_handler(app):
    from ragbot.commands.media import bicture

    kv = MemoryKV()
    resources = dict(FILES)
    image = json.loads(resources["bicture-image.json"])
    profile = image["profiles"][image["activeProfile"]]
    profile.update(
        model="google/nano-banana-2", parameters={"resolution": "1K", "aspect_ratio": "1:1"}
    )
    resources["bicture-image.json"] = json.dumps(image)
    await editor(kv).write(resources, "test-seed")
    app.config = ConfigStore(SimpleNamespace(AI_CONFIG=kv, DB=kv.db))
    app.ai.media = AsyncMock(return_value={"image": "YWJj"})
    ctx = SimpleNamespace(
        app=app,
        option=lambda _: "A tree",
        attribution=lambda _: None,
        reply=AsyncMock(return_value=True),
    )
    await bicture(ctx)
    saved_profile, request, _ = app.ai.media.call_args.args
    assert saved_profile["model"] == "google/nano-banana-2"
    assert request == {"resolution": "1K", "aspect_ratio": "1:1", "prompt": "A tree"}


async def test_chat_model_save_persists_server_selected_api_format():
    kv = MemoryKV()
    ui = editor(kv)
    ui.catalog.validate = AsyncMock(
        return_value={
            "chat": [
                {"id": "openai/example-responses", "apiFormat": "responses"},
                {"id": "example/chat", "apiFormat": "chat-completions"},
            ]
        }
    )
    for model, expected in [
        ("openai/example-responses", "responses"),
        ("example/chat", "chat-completions"),
    ]:
        current = await ui.read()
        body = {
            "page": "chat",
            "baseRevision": current["revision"],
            "overrides": {"model": model, "chatApiFormat": "untrusted"},
        }
        body["reviewId"] = (await ui.preview(body))["reviewId"]
        saved = await ui.save(body)
        config, _ = await ConfigStore(SimpleNamespace(DB=kv.db)).models()
        assert config.model == model and config.api_format == expected
        assert saved["config"]["chatApiFormat"] == expected
