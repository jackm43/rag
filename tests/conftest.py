import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from settings_seed import load_resources

from ragbot.app import Application


class Statement:
    def __init__(self, db, sql, params=()):
        self.db, self.sql, self.params = db, sql, params

    def bind(self, *params):
        return Statement(self.db, self.sql, params)

    def execute(self):
        cursor = self.db.connection.execute(self.sql, self.params)
        rows = [dict(row) for row in cursor.fetchall()] if cursor.description else []
        return {"results": rows, "meta": {"changes": max(cursor.rowcount, 0)}}

    async def first(self):
        rows = self.execute()["results"]
        return rows[0] if rows else None

    async def all(self):
        return self.execute()

    async def run(self):
        return self.execute()


class SQLiteBinding:
    def __init__(self, *, settings=False):
        self.connection = sqlite3.connect(":memory:")
        self.connection.row_factory = sqlite3.Row
        for migration in sorted(Path("migrations").glob("*.sql")):
            self.connection.executescript(migration.read_text())
        if settings:
            self.connection.execute(
                "INSERT INTO ai_runtime_settings (id, revision, document) VALUES (1, ?, ?)",
                (
                    "test-seed",
                    json.dumps(
                        {"schemaVersion": 2, "revision": "test-seed", "resources": load_resources()}
                    ),
                ),
            )

    def prepare(self, sql):
        return Statement(self, sql)

    async def batch(self, statements):
        with self.connection:
            return [statement.execute() for statement in statements]


class FakeResponse:
    def __init__(self, body=None, status=200):
        self.body, self.status, self.ok = body, status, 200 <= status < 300
        self.headers = {"content-type": "application/json"}

    async def text(self):
        return json.dumps(self.body)

    async def json(self):
        return self.body


class Transport:
    def __init__(self):
        self.calls = []
        self.handler = None

    async def __call__(self, url, **options):
        self.calls.append((url, options))
        if self.handler:
            result = self.handler(url, options)
            if result is not None:
                return result
        return FakeResponse({"id": "123456789012345691", "type": 0})

    def writes(self):
        return [
            json.loads(options["body"])
            for url, options in self.calls
            if "discord.com" in url and isinstance(options.get("body"), str)
        ]


@pytest.fixture
def app(monkeypatch):
    env = SimpleNamespace(
        DB=SQLiteBinding(settings=True),
        DISCORD_BOT_TOKEN="test-bot-token",
        DISCORD_APPLICATION_ID="123456789012345678",
        ALLOWED_GUILD_IDS="457689460096630794",
        CF_ACCOUNT_ID="test-account",
        CLOUDFLARE_API_TOKEN="test-cf-token",
        AI=SimpleNamespace(
            run=AsyncMock(
                return_value={
                    "model": "test-model",
                    "choices": [
                        {
                            "message": {
                                "content": "Assistant: hello <@123456789012345678> https://example.com"
                            }
                        }
                    ],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14},
                }
            )
        ),
    )
    transport = Transport()
    return Application(env, transport=transport)


@pytest.fixture
def interaction():
    def make(
        name, *, user="123456789012345679", options=None, guild="457689460096630794", roles=None
    ):
        return {
            "id": "123456789012345680",
            "type": 2,
            "application_id": "123456789012345678",
            "token": "test-webhook-token",
            "guild_id": guild,
            "channel_id": "123456789012345681",
            "member": {"user": {"id": user, "username": "requester"}, "roles": roles or []},
            "data": {
                "name": name,
                "options": options or [],
                "resolved": {
                    "users": {
                        "123456789012345682": {"id": "123456789012345682", "username": "target"}
                    }
                },
            },
        }

    return make
