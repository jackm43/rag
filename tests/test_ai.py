import json

from conftest import FakeResponse

from ragbot.reconcile import reconcile_spend


async def test_reconcile_preserves_pending_and_is_idempotent(app):
    await app.db.run(
        "INSERT INTO rag_ai_spend_events (source_id, kind, requester_user_id, model, status) VALUES (?, ?, ?, ?, ?)",
        "aigreq:one",
        "ask",
        "user",
        "model",
        "pending",
    )
    await app.db.run(
        "INSERT INTO rag_ai_spend_events (source_id, kind, requester_user_id, model, status) VALUES (?, ?, ?, ?, ?)",
        "aigreq:two",
        "ask",
        "user",
        "model",
        "pending",
    )
    app.transport.handler = lambda url, options: FakeResponse(
        {
            "result": [
                {"metadata": {"ragbot_request_id": "aigreq:one"}, "cost": "0.002"},
                {"metadata": {"ragbot_request_id": "aigreq:two"}, "cost": None},
            ]
        }
    )
    assert await reconcile_spend(app) == {"reconciled": 1, "scanned": 2}
    assert await reconcile_spend(app) == {"reconciled": 0, "scanned": 1}
    total = await app.db.first(
        "SELECT * FROM rag_ai_spend_totals WHERE requester_user_id = ?", "user"
    )
    assert total["estimated_cost_micros"] == 2000 and total["event_count"] == 1


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
    message["content"] = "weather today"
    await app.handle_message(message, app.env.DISCORD_APPLICATION_ID)
    ai_calls = [
        json.loads(options["body"])
        for url, options in app.transport.calls
        if "gateway.ai.cloudflare.com" in url
    ]
    assert "web_search_options" not in ai_calls[0]
    assert "web_search_options" in ai_calls[-1]
