"""A fresh primary D1 settings snapshot for each AI request."""

import json
import math
from dataclasses import dataclass
from typing import Any

from .runtime import env_value, to_python
from .settings_storage import READ_SETTINGS

RESOURCE_NAMES = (
    "discord-response.json",
    "discord-response-system-prompt.md",
    "bicture-image.json",
)


def parse_settings(raw: str) -> dict:
    data = json.loads(raw)
    if not isinstance(data, dict) or data.get("schemaVersion") != 2:
        raise ValueError("invalid settings version")
    resources = data.get("resources")
    if not isinstance(resources, dict) or set(resources) != set(RESOURCE_NAMES):
        raise ValueError("incomplete settings snapshot")
    if any(not isinstance(value, str) or len(value) > 100000 for value in resources.values()):
        raise ValueError("invalid settings resource")
    for key, value in resources.items():
        if key.endswith(".json") and not isinstance(json.loads(value), dict):
            raise ValueError("invalid settings document")
    for key in ("discord-response.json",):
        model = json.loads(resources[key]).get("model")
        if not isinstance(model, str) or not model.strip():
            raise ValueError("missing settings model")
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
    temperature: float
    gateway_id: str | None
    history_limit: int = 12
    api_format: str = "chat-completions"
    revision: str = "unspecified"
    temperature_supported: bool = True
    reasoning_effort: str | None = None


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
            return parse_settings(json.dumps(self._fixed))
        db = env_value(self.env, "DB")
        if db is None:
            raise ValueError("D1 settings binding is required")
        # Without a Sessions API replica session, D1 bindings query the primary.
        row = to_python(await db.prepare(READ_SETTINGS).first())
        if row is None:
            raise ValueError("AI settings are not initialized in D1")
        snapshot = parse_settings(row["document"])
        if snapshot.get("revision") != row["revision"]:
            raise ValueError("settings revision mismatch")
        return {**snapshot, "source": "d1"}

    @staticmethod
    def document_from(snapshot: dict, key: str) -> dict:
        return json.loads(snapshot["resources"][key])

    async def document(self, key: str) -> dict:
        return self.document_from(await self.snapshot(), key)

    async def chat(self) -> ModelConfig:
        snapshot = await self.snapshot()
        data = self.document_from(snapshot, "discord-response.json")
        gateway = data.get("gatewayId")
        effort = data.get("reasoningEffort")
        return ModelConfig(
            revision=snapshot["revision"],
            model=data["model"].strip(),
            prompt=snapshot["resources"]["discord-response-system-prompt.md"].strip(),
            temperature_supported=data.get("temperatureSupported", True) is True,
            reasoning_effort=effort if effort in ("low", "medium", "high", "xhigh") else None,
            temperature=number(data.get("temperature"), 0.7, maximum=2),
            gateway_id=gateway.strip() or None if isinstance(gateway, str) else None,
            history_limit=int(number(data.get("historyLimit"), 12, minimum=1)),
            api_format="responses" if data.get("apiFormat") == "responses" else "chat-completions",
        )
