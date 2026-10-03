import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from conftest import SQLiteBinding
from settings_api import SettingsEditor, SettingsError
from settings_seed import load_resources

from ragbot.config import ConfigStore
from ragbot.settings_storage import READ_SETTINGS, WRITE_SETTINGS

FILES = load_resources()


def editor(db, **kwargs):
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
        SimpleNamespace(DB=db),
        "local",
        destination={"worker": "test"},
        catalog=catalog,
        **kwargs,
    )


async def test_save_refreshes_existing_production_store_without_redeploy():
    db = SQLiteBinding(settings=True)
    store = ConfigStore(SimpleNamespace(DB=db))
    old_chat = await store.chat()
    ui = editor(db)
    before = await ui.read()
    body = {
        "page": "chat",
        "baseRevision": before["revision"],
        "overrides": {"systemPrompt": "Reply briefly.", "temperature": 0.2},
    }
    body["reviewId"] = (await ui.preview(body))["reviewId"]
    saved = await ui.save(body)
    assert saved["source"] == "d1"
    chat = await store.chat()  # No timer change or new application.
    assert chat.prompt == "Reply briefly." and chat.prompt != old_chat.prompt
    assert chat.temperature == 0.2
    assert chat.revision == saved["revision"]
    assert (await ui.read())["revision"] == saved["revision"]
    # Invalid current data must never silently serve a stale cached configuration.
    db.connection.execute("UPDATE ai_runtime_settings SET document = '{}' WHERE id = 1")
    with pytest.raises(ValueError):
        await store.chat()


async def test_conditional_database_writes_reject_a_concurrent_editor():
    db = SQLiteBinding(settings=True)
    first, second = editor(db), editor(db)
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


async def test_primary_read_failure_stops_inference_instead_of_using_old_settings(app):
    await app.config.chat()
    app.env.DB.prepare = lambda _: (_ for _ in ()).throw(RuntimeError("unavailable"))
    with pytest.raises(RuntimeError):
        await app.config.chat()
    assert not app.transport.calls


@pytest.mark.parametrize("database", [None, "empty"])
async def test_uninitialized_settings_stop_ai(app, database):
    app.env.DB = SQLiteBinding() if database == "empty" else None
    with pytest.raises(ValueError, match="D1"):
        await app.config.chat()
    app.env.AI.run.assert_not_awaited()
    assert not app.transport.calls


async def test_editor_requires_initialized_d1():
    db = SQLiteBinding()
    with pytest.raises(SettingsError, match="not initialized"):
        await editor(db).read()
    assert not db.connection.execute("SELECT * FROM ai_runtime_settings").fetchall()


@pytest.mark.parametrize("model", [None, "", 123])
async def test_invalid_saved_model_has_no_packaged_default(model):
    db = SQLiteBinding(settings=True)
    resources = dict(FILES)
    resources["discord-response.json"] = json.dumps({"model": model})
    with pytest.raises(ValueError, match="missing settings model"):
        await editor(db).write(resources, "test-seed")


async def test_saved_documents_do_not_merge_file_defaults():
    db = SQLiteBinding(settings=True)
    resources = dict(FILES)
    resources["discord-response.json"] = json.dumps({"model": "example/chat"})
    await editor(db).write(resources, "test-seed")
    store = ConfigStore(SimpleNamespace(DB=db))
    assert await store.document("discord-response.json") == {"model": "example/chat"}


async def test_models_are_one_coherent_snapshot_from_one_query():
    db = SQLiteBinding(settings=True)
    saved = await editor(db).read()
    calls = []
    prepare = db.prepare

    def record(sql):
        calls.append(sql)
        return prepare(sql)

    db.prepare = record
    store = ConfigStore(SimpleNamespace(DB=db))
    chat = await store.chat()
    assert calls == [READ_SETTINGS]
    assert chat.revision == saved["revision"]
    newer = dict(saved["resources"])
    newer["discord-response-system-prompt.md"] = "New prompt"
    await editor(db).write(newer, saved["revision"])
    assert chat.prompt != (await store.chat()).prompt


async def test_stale_or_altered_review_cannot_overwrite_saved_settings():
    db = SQLiteBinding(settings=True)
    ui = editor(db)
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
    db = SQLiteBinding(settings=True)
    ui = editor(db)
    before = await ui.read()
    with pytest.raises(ValueError):
        await ui.preview(
            {"page": "chat", "baseRevision": before["revision"], "overrides": overrides}
        )


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

    db = SQLiteBinding(settings=True)
    resources = dict(FILES)
    image = json.loads(resources["bicture-image.json"])
    profile = image["profiles"][image["activeProfile"]]
    profile.update(
        model="google/nano-banana-2", parameters={"resolution": "1K", "aspect_ratio": "1:1"}
    )
    resources["bicture-image.json"] = json.dumps(image)
    await editor(db).write(resources, "test-seed")
    app.config = ConfigStore(SimpleNamespace(DB=db))
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
    db = SQLiteBinding(settings=True)
    ui = editor(db)
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
        config = await ConfigStore(SimpleNamespace(DB=db)).chat()
        assert config.model == model and config.api_format == expected
        assert saved["config"]["chatApiFormat"] == expected
