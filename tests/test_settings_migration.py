"""Settings upgrades preserve operator choices without runtime compatibility code."""

import json
import sqlite3
from pathlib import Path

import pytest
from settings_seed import load_resources

from ragbot.config import parse_settings


@pytest.mark.parametrize(
    "model,expected",
    [
        ("grok/grok-4.6", "xai/grok-4.6"),
        ("google-ai-studio/gemini-2.5-flash", "google/gemini-2.5-flash"),
        ("workers-ai/@cf/example/model", "@cf/example/model"),
        ("openai/gpt-5", "openai/gpt-5"),
    ],
)
def test_settings_upgrade_preserves_operator_values_and_is_idempotent(model, expected):
    db = sqlite3.connect(":memory:")
    db.executescript(Path("migrations/0003_ai_runtime_settings.sql").read_text())
    resources = load_resources()
    resources["discord-response-system-prompt.md"] = "Keep my custom prompt exactly.\n"
    chat = {
        "model": model,
        "gatewayId": "custom",
        "temperature": 0.4,
        "historyLimit": 7,
        "reasoningEffort": "low",
        "maxTokens": 1000,
    }
    resources["discord-response.json"] = json.dumps(chat)
    image = {
        "activeProfile": "custom",
        "profiles": {
            "custom": {"model": model, "parameters": {"resolution": "2K"}, "gatewayId": "custom"},
            "other": {"model": "new-provider/image", "quality": "high"},
        },
    }
    resources["bicture-image.json"] = json.dumps(image)
    resources.update({"ask-web-search.json": "{}", "ask-web-search-system-prompt.md": "unused"})
    db.execute(
        "INSERT INTO ai_runtime_settings VALUES (1, ?, ?)",
        (
            "original",
            json.dumps({"schemaVersion": 1, "revision": "original", "resources": resources}),
        ),
    )
    migration = Path("migrations/0004_chat_image_settings.sql").read_text()
    db.executescript(migration)
    row = db.execute("SELECT revision, document FROM ai_runtime_settings").fetchone()
    snapshot = parse_settings(row[1])
    assert snapshot["revision"] == row[0] == "chat-image:original"
    assert (
        snapshot["resources"]["discord-response-system-prompt.md"]
        == resources["discord-response-system-prompt.md"]
    )
    assert json.loads(snapshot["resources"]["discord-response.json"]) == {
        k: expected if k == "model" else v for k, v in chat.items() if k != "maxTokens"
    }
    image["profiles"]["custom"]["model"] = expected
    assert json.loads(snapshot["resources"]["bicture-image.json"]) == image
    db.executescript(migration)
    assert db.execute("SELECT revision, document FROM ai_runtime_settings").fetchone() == row


def test_settings_upgrade_leaves_empty_database_for_explicit_initialization():
    db = sqlite3.connect(":memory:")
    db.executescript(Path("migrations/0003_ai_runtime_settings.sql").read_text())
    db.executescript(Path("migrations/0004_chat_image_settings.sql").read_text())
    assert db.execute("SELECT * FROM ai_runtime_settings").fetchall() == []
