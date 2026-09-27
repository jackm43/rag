"""Prompt replay reads existing D1 history without changing saved data."""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from conftest import FakeResponse, SQLiteBinding
from settings_api import READ_HISTORY, SettingsEditor, SettingsError


def history_editor(db, target="local", transport=None):
    options = {"transport": transport} if transport else {}
    return SettingsEditor(
        SimpleNamespace(DB=db, CLOUDFLARE_API_TOKEN="test-token"),
        target,
        destination={"account": "a" * 32, "database": "b" * 36},
        **options,
    )


async def test_history_filters_searches_and_pages_without_duplicates():
    db = SQLiteBinding()
    for index in range(30):
        await (
            db.prepare(
                "INSERT INTO rag_ai_interactions (kind, prompt, model, status) VALUES (?, ?, ?, ?)"
            )
            .bind("bicture", f"Tree {index}", "test/image", "ok")
            .run()
        )
    for kind in ("ask", "channel_reply", "thread_reply", "unrelated"):
        await (
            db.prepare(
                "INSERT INTO rag_ai_interactions (kind, prompt, model, status) VALUES (?, ?, ?, ?)"
            )
            .bind(kind, "hello", "test/chat", "error")
            .run()
        )
    editor = history_editor(db)
    first = await editor.history({"page": "bicture", "search": "TREE"})
    second = await editor.history({"page": "bicture", "before": first["next"]})
    assert len(first["entries"]) == 25 and len(second["entries"]) == 5
    assert second["next"] is None
    assert [row["id"] for row in first["entries"] + second["entries"]] == list(range(30, 0, -1))
    chat = await editor.history({"page": "chat"})
    assert {row["kind"] for row in chat["entries"]} == {"ask", "channel_reply", "thread_reply"}
    assert not (await editor.history({"page": "chat", "search": "' OR 1=1 --"}))["entries"]
    assert not (await editor.history({"page": "bicture", "search": "%"}))["entries"]
    assert db.connection.execute("SELECT count(*) FROM rag_ai_interactions").fetchone()[0] == 34


async def test_live_history_uses_fixed_read_only_query_and_configured_destination():
    transport = AsyncMock(
        return_value=FakeResponse({"success": True, "result": [{"success": True, "results": []}]})
    )
    editor = history_editor(None, "live", transport)
    assert await editor.history({"page": "bicture"}) == {"entries": [], "next": None}
    url = transport.call_args.args[0]
    assert (
        url
        == f"https://api.cloudflare.com/client/v4/accounts/{'a' * 32}/d1/database/{'b' * 36}/query"
    )
    request = json.loads(transport.call_args.kwargs["body"])
    assert request == {"sql": READ_HISTORY, "params": ["bicture", "bicture", None, None, "", ""]}
    transport.return_value = FakeResponse({"error": "private failure"}, 403)
    with pytest.raises(SettingsError, match="D1 permissions"):
        await editor.history({"page": "chat"})


@pytest.mark.parametrize(
    "body",
    [
        {"page": "other"},
        {"page": "chat", "before": True},
        {"page": "chat", "before": -1},
        {"page": "chat", "before": "1"},
        {"page": "chat", "search": []},
        {"page": "chat", "search": "x" * 501},
    ],
)
async def test_invalid_history_filters_never_query(body):
    editor = history_editor(None)
    editor.query = AsyncMock()
    with pytest.raises(SettingsError):
        await editor.history(body)
    editor.query.assert_not_awaited()
