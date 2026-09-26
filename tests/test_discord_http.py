import json

import pytest
from conftest import FakeResponse

from ragbot.discord_http import DiscordHTTP, DiscordRateLimitError, route_key


class Clock:
    now = 0.0

    def __init__(self):
        self.waits = []

    def time(self):
        return self.now

    async def sleep(self, delay):
        self.waits.append(delay)
        self.now += delay


def limiter(app):
    clock = Clock()
    app.discord._http = DiscordHTTP(clock=clock.time, sleep=clock.sleep)
    return clock


async def test_rate_limit_retries_same_payload_without_webhook_bot_token(app):
    clock = limiter(app)
    attempts = []

    def respond(url, options):
        attempts.append(options)
        return (
            FakeResponse({"retry_after": 0.25, "global": True}, 429)
            if len(attempts) == 1
            else FakeResponse({})
        )

    app.transport.handler = respond
    assert await app.discord.write_interaction("123", "webhook-token", "hello")
    assert clock.waits == [0.25]
    assert len(attempts) == 2
    assert attempts[0]["body"] == attempts[1]["body"]
    assert all("authorization" not in attempt["headers"] for attempt in attempts)
    assert json.loads(attempts[0]["body"])["content"] == "hello"


async def test_bot_auth_and_api_failure_are_preserved(app):
    app.transport.handler = lambda url, options: FakeResponse({"message": "forbidden"}, 403)
    result = await app.discord.post_message("123", "hello")
    assert not result.ok and result.status == 403
    assert len(app.transport.calls) == 1
    assert app.transport.calls[-1][1]["headers"]["authorization"] == "Bot test-bot-token"


async def test_proactive_bucket_limit_and_global_limit_cross_routes(app):
    clock = limiter(app)
    response = FakeResponse({})
    response.headers.update(
        {
            "x-ratelimit-bucket": "messages",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset-after": "2.5",
        }
    )
    app.transport.handler = lambda url, options: response
    await app.discord.post_message("123", "first")
    await app.discord.post_message("123", "second")
    assert clock.waits == [2.5]
    app.discord._http.global_until["bot"] = clock.now + 3
    app.transport.handler = lambda url, options: FakeResponse({})
    await app.discord.request("/users/456")
    assert clock.waits[-1] == 3


async def test_retry_budget_retains_long_global_pause(app):
    clock = limiter(app)
    app.transport.handler = lambda url, options: FakeResponse(
        {"retry_after": 60, "global": True}, 429
    )
    with pytest.raises(DiscordRateLimitError):
        await app.discord.post_message("123", "hello")
    with pytest.raises(DiscordRateLimitError):
        await app.discord.request("/users/456")
    assert len(app.transport.calls) == 1
    assert clock.waits == []


async def test_transient_get_failure_retries_but_post_is_not_replayed(app):
    clock = limiter(app)
    app.transport.handler = lambda url, options: FakeResponse({}, 503)
    result = await app.discord.request("/users/123")
    assert result.status == 503
    assert len(app.transport.calls) == 4
    assert clock.waits == [0.5, 1.0, 2.0]
    result = await app.discord.post_message("123", "must not duplicate")
    assert result.status == 503
    assert len(app.transport.calls) == 5


async def test_malformed_rate_limit_is_not_retried(app):
    limiter(app)
    app.transport.handler = lambda url, options: FakeResponse({"retry_after": "nan"}, 429)
    assert (await app.discord.post_message("123", "hello")).status == 429
    assert len(app.transport.calls) == 1


def test_route_keys_ignore_query_and_keep_major_resources():
    assert route_key("https://discord.com/api/v10/channels/123/messages/456", "GET") == route_key(
        "https://discord.com/api/v10/channels/123/messages/789", "GET"
    )
    first = route_key("https://discord.com/api/v10/channels/123/messages?before=456", "GET")
    second = route_key("https://discord.com/api/v10/channels/789/messages", "GET")
    assert first[0] == second[0] and first[1] != second[1]
    webhook = route_key(
        "https://discord.com/api/v10/webhooks/123/secret/messages/@original", "PATCH"
    )
    assert "secret" not in webhook[0][1]
    assert webhook[1] == ("webhooks", "123", "secret")
