"""A fresh primary D1 snapshot for each AI request, with legacy startup fallback."""

import asyncio
import hashlib
import json
import math
from dataclasses import dataclass
from typing import Any

from ._bundled import FILES
from .runtime import env_value, to_python
from .settings_storage import READ_SETTINGS

SETTINGS_KEY = "runtime-settings.json"


def resource_revision(resources: dict) -> str:
    normalized = {
        key: json.loads(value) if key.endswith(".json") else value
        for key, value in resources.items()
    }
    return hashlib.sha256(json.dumps(normalized, sort_keys=True).encode()).hexdigest()


async def legacy_snapshot(get) -> dict:
    raw = await get(SETTINGS_KEY)
    if raw is not None:
        snapshot = parse_settings(raw)
    else:
        values = await asyncio.gather(*(get(key) for key in FILES))
        resources = {}
        for key, value in zip(FILES, values):
            if value is not None and key.endswith(".json"):
                value = json.dumps(json.loads(FILES[key]) | json.loads(value))
            resources[key] = FILES[key] if value is None else value
        snapshot = {"schemaVersion": 1, "resources": resources}
        parse_settings(json.dumps(snapshot))
    return {
        **snapshot,
        "revision": "legacy-" + resource_revision(snapshot["resources"]),
        "source": "legacy",
    }


def parse_settings(raw: str) -> dict:
    data = json.loads(raw)
    if not isinstance(data, dict) or data.get("schemaVersion") != 1:
        raise ValueError("invalid settings version")
    resources = data.get("resources")
    if not isinstance(resources, dict) or set(resources) != set(FILES):
        raise ValueError("incomplete settings snapshot")
    if any(not isinstance(value, str) or len(value) > 100000 for value in resources.values()):
        raise ValueError("invalid settings resource")
    for key, value in resources.items():
        if key.endswith(".json") and not isinstance(json.loads(value), dict):
            raise ValueError("invalid settings document")
    image = json.loads(resources["bicture-image.json"])
    profiles = image.get("profiles")
    if not isinstance(profiles, dict) or image.get("activeProfile") not in profiles:
        raise ValueError("invalid image profiles")
    for profile in profiles.values():
        if not isinstance(profile, dict) or not isinstance(profile.get("model"), str):
            raise ValueError("invalid image profile")
        if "parameters" in profile and (
            not isinstance(profile["parameters"], dict)
            or set(profile["parameters"])
            - {"response_format", "aspect_ratio", "quality", "resolution"}
            or any(not isinstance(value, str) for value in profile["parameters"].values())
        ):
            raise ValueError("invalid image parameters")
    return data


@dataclass(frozen=True)
class ModelConfig:
    model: str
    prompt: str
    max_tokens: int
    temperature: float
    gateway_id: str | None
    history_limit: int = 12
    max_turns: int = 4
    search_context_size: str = "medium"
    api_format: str = "chat-completions"
    revision: str = "bundled"
    temperature_supported: bool = True


def number(value: Any, fallback: float, *, minimum: float = 0, maximum: float = math.inf) -> float:
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) and minimum <= parsed <= maximum else fallback
    except ValueError, TypeError:
        return fallback


class ConfigStore:
    def __init__(self, env: Any, *, snapshot: dict | None = None):
        self.env = env
        self._fixed = snapshot

    async def snapshot(self) -> dict:
        if self._fixed is not None:
            return self._fixed
        db = env_value(self.env, "DB")
        if db is not None:
            # Without a Sessions API replica session, D1 bindings query the primary.
            # Never fall back to stale data after a failed primary read.
            row = to_python(await db.prepare(READ_SETTINGS).first())
            if row is not None:
                snapshot = parse_settings(row["document"])
                if snapshot.get("revision") != row["revision"]:
                    raise ValueError("settings revision mismatch")
                return {**snapshot, "source": "d1"}
        kv = env_value(self.env, "AI_CONFIG")

        async def get(key):
            return await kv.get(key) if kv is not None else None

        return await legacy_snapshot(get)

    @staticmethod
    def document_from(snapshot: dict, key: str) -> dict:
        return json.loads(FILES[key]) | json.loads(snapshot["resources"][key])

    async def text(self, key: str) -> str:
        return (await self.snapshot())["resources"][key]

    async def document(self, key: str) -> dict:
        return self.document_from(await self.snapshot(), key)

    async def models(self) -> tuple[ModelConfig, ModelConfig]:
        snapshot = await self.snapshot()
        chat = self.document_from(snapshot, "discord-response.json")
        search = self.document_from(snapshot, "ask-web-search.json")
        chat_prompt = snapshot["resources"]["discord-response-system-prompt.md"]
        search_prompt = snapshot["resources"]["ask-web-search-system-prompt.md"]

        def model(data, prompt, key, search=False):
            fallback = json.loads(FILES[key])["model"]
            name = data.get("model")
            gateway = data.get("gatewayId")
            size = data.get("searchContextSize")
            return ModelConfig(
                revision=snapshot["revision"],
                model=name if isinstance(name, str) and name.strip() else fallback,
                prompt=prompt.strip(),
                max_tokens=int(
                    number(
                        data.get("maxOutputTokens" if search else "maxTokens"),
                        1200 if search else 256,
                        minimum=1,
                    )
                ),
                temperature_supported=data.get("temperatureSupported", True) is True,
                temperature=number(data.get("temperature"), 0.3 if search else 0.7, maximum=2),
                gateway_id=gateway.strip() or None if isinstance(gateway, str) else None,
                history_limit=int(number(data.get("historyLimit"), 12, minimum=1)),
                max_turns=int(number(data.get("maxTurns"), 4, minimum=1)),
                search_context_size=size if size in ("low", "medium", "high") else "medium",
                api_format="responses"
                if data.get("apiFormat") == "responses"
                else "chat-completions",
            )

        return (
            model(chat, chat_prompt, "discord-response.json"),
            model(search, search_prompt, "ask-web-search.json", True),
        )
