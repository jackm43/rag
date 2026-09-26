"""KV overrides with bundled fallbacks, resolved once per application instance."""

import asyncio
import json
import logging
import math
from dataclasses import dataclass
from typing import Any

from ._bundled import FILES
from .runtime import env_value

log = logging.getLogger("ragbot")


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


def number(value: Any, fallback: float, *, minimum: float = 0, maximum: float = math.inf) -> float:
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) and minimum <= parsed <= maximum else fallback
    except ValueError, TypeError:
        return fallback


class ConfigStore:
    def __init__(self, env: Any):
        self.env = env
        self._models: tuple[ModelConfig, ModelConfig] | None = None

    async def text(self, key: str) -> str:
        kv = env_value(self.env, "AI_CONFIG")
        if kv:
            try:
                value = await kv.get(key)
                if isinstance(value, str):
                    return value
            except Exception:
                log.warning("ai_config_kv_read_failed key=%s", key)
        return FILES[key]

    async def document(self, key: str) -> dict:
        fallback = json.loads(FILES[key])
        try:
            override = json.loads(await self.text(key))
            if isinstance(override, dict):
                return fallback | override
        except TypeError, ValueError:
            log.warning("ai_config_kv_parse_failed key=%s", key)
        return fallback

    async def models(self) -> tuple[ModelConfig, ModelConfig]:
        if self._models:
            return self._models
        chat, search, chat_prompt, search_prompt = await asyncio.gather(
            self.document("discord-response.json"),
            self.document("ask-web-search.json"),
            self.text("discord-response-system-prompt.md"),
            self.text("ask-web-search-system-prompt.md"),
        )

        def model(data, prompt, key, search=False):
            fallback = json.loads(FILES[key])["model"]
            name = data.get("model")
            gateway = data.get("gatewayId")
            size = data.get("searchContextSize")
            return ModelConfig(
                model=name if isinstance(name, str) and name.strip() else fallback,
                prompt=prompt.strip(),
                max_tokens=int(
                    number(
                        data.get("maxOutputTokens" if search else "maxTokens"),
                        1200 if search else 256,
                        minimum=1,
                    )
                ),
                temperature=number(data.get("temperature"), 0.3 if search else 0.7, maximum=2),
                gateway_id=gateway.strip() or None if isinstance(gateway, str) else None,
                history_limit=int(number(data.get("historyLimit"), 12, minimum=1)),
                max_turns=int(number(data.get("maxTurns"), 4, minimum=1)),
                search_context_size=size if size in ("low", "medium", "high") else "medium",
            )

        self._models = (
            model(chat, chat_prompt, "discord-response.json"),
            model(search, search_prompt, "ask-web-search.json", True),
        )
        return self._models
