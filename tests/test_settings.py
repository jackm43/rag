import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from conftest import SQLiteBinding
from settings_api import SettingsEditor, SettingsError

from ragbot._bundled import FILES
from ragbot.config import SETTINGS_KEY, ConfigStore
from ragbot.settings_storage import READ_SETTINGS, WRITE_SETTINGS


class MemoryKV:
    def __init__(self):
        self.values = {}
        self.db = SQLiteBinding()

    async def get(self, key):
        return self.values.get(key)

    async def put(self, key, value):
        self.values[key] = value


def editor(kv, **kwargs):
    catalog = SimpleNamespace(validate=AsyncMock(return_value={}))
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


async def test_conditional_database_writes_reject_a_concurrent_editor():
    kv = MemoryKV()
    first, second = editor(kv), editor(kv)
    current = await first.initialize()
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


async def test_migration_preserves_legacy_settings_and_is_idempotent():
    kv = MemoryKV()
    resources = dict(FILES)
    resources["discord-response-system-prompt.md"] = "Preserved live prompt"
    kv.values[SETTINGS_KEY] = json.dumps(
        {"schemaVersion": 1, "resources": resources, "revision": "old-kv"}
    )
    ui = editor(kv)
    current = await ui.initialize()
    assert current["source"] == "d1" and current["resources"] == resources
    assert (await ui.initialize())["revision"] == current["revision"]
    kv.values[SETTINGS_KEY] = "invalid legacy snapshot"
    assert (await ConfigStore(SimpleNamespace(DB=kv.db, AI_CONFIG=kv)).models())[
        0
    ].prompt == "Preserved live prompt"


async def test_primary_read_failure_stops_inference_instead_of_using_old_settings(app):
    await app.config.models()
    app.env.DB.prepare = lambda _: (_ for _ in ()).throw(RuntimeError("unavailable"))
    with pytest.raises(RuntimeError):
        await app.ai.ask("Hello", "user", [], SimpleNamespace())
    assert not app.transport.calls


async def test_models_are_one_coherent_snapshot_from_one_query():
    kv = MemoryKV()
    saved = await editor(kv).initialize()
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
    await editor(kv).write(resources, None)
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
