from harness import Simulation, resolve_config


async def test_dev_mention_captures_exchange_without_discord_egress(app):
    inputs = {
        "identity": {
            "userId": "123456789012345679",
            "username": "tester",
            "globalName": None,
            "nick": None,
        },
        "channelId": "123456789012345681",
        "guildId": "457689460096630794",
        "botUserId": app.env.DISCORD_APPLICATION_ID,
        "content": "hello",
        "mentionBot": True,
        "mode": "channel",
        "transcript": [],
        "overrides": {"model": "test/dev-model"},
    }
    result = await Simulation(app.env, inputs, upstream=app.transport).run("mention")
    assert len(result["replies"]) == 1
    assert result["ai"][0]["model"] == "test/dev-model"
    assert result["ai"][0]["request"]["headers"]["cf-aig-authorization"] == "[redacted]"
    assert all("discord.com" not in url for url, _ in app.transport.calls)
    assert result["db"]["interaction"]["status"] == "ok"


async def test_dev_thread_history_and_config_isolation(app):
    inputs = {
        "identity": {
            "userId": "123456789012345679",
            "username": "tester",
            "globalName": None,
            "nick": None,
        },
        "channelId": "123456789012345681",
        "guildId": "457689460096630794",
        "botUserId": app.env.DISCORD_APPLICATION_ID,
        "content": "explain more",
        "mode": "ask_thread",
        "transcript": [{"id": "123456789012345680", "role": "user", "content": "explain trees"}],
        "overrides": {"model": "custom/model"},
    }
    result = await Simulation(app.env, inputs, upstream=app.transport).run("mention")
    assert result["replies"]
    assert result["ai"][0]["model"] == "custom/model"
    config = await resolve_config({})
    assert config["responseModel"] != "custom/model"


async def test_dev_webhooks_redacted_and_stubbed(app):
    inputs = {
        "identity": {"userId": "123456789012345679", "username": "tester"},
        "channelId": "123456789012345681",
        "guildId": "457689460096630794",
        "command": "ragboard",
        "options": [],
    }
    result = await Simulation(app.env, inputs, upstream=app.transport).run("interaction")
    assert result["edits"][0]["content"] == "No rags have been recorded yet."
    assert "[redacted]" in result["calls"][0]["url"]
    assert not app.transport.calls
