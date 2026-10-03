"""Operator-only inputs for initializing D1; never imported by the Worker."""

import json
from pathlib import Path

SETTINGS_KEY = "runtime-settings.json"


def load_resources():
    directory = Path(__file__).resolve().parents[1] / "config/ai"
    return {
        path.name: path.read_text(encoding="utf-8")
        for path in sorted(directory.iterdir())
        if path.suffix in (".json", ".md")
    }


async def legacy_resources(get):
    from ragbot.config import parse_settings

    raw = await get(SETTINGS_KEY)
    if raw is not None:
        return parse_settings(raw)["resources"]
    resources = load_resources()
    for key in resources:
        value = await get(key)
        if value is not None:
            resources[key] = (
                json.dumps(json.loads(resources[key]) | json.loads(value))
                if key.endswith(".json")
                else value
            )
    parse_settings(json.dumps({"schemaVersion": 1, "resources": resources}))
    return resources
