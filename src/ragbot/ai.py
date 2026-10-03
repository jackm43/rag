"""Chat and image inference with request attribution."""

import math
import re
import uuid
from dataclasses import dataclass
from typing import Any

from .config import ModelConfig
from .runtime import to_python


@dataclass(frozen=True)
class Attribution:
    kind: str
    user_id: str | None = None
    username: str | None = None
    channel_id: str | None = None
    message_id: str | None = None

    def metadata(self, request_id: str) -> dict:
        return {
            key: value
            for key, value in {
                "ragbot_kind": self.kind,
                "ragbot_request_id": request_id,
                "discord_user_id": self.user_id,
                "discord_channel_id": self.channel_id,
                "discord_message_id": self.message_id,
            }.items()
            if value
        }


@dataclass
class Completion:
    content: str
    model: str
    usage: dict | None = None


def extract_text(payload: Any) -> str:
    if isinstance(payload, str):
        return payload
    if not isinstance(payload, dict):
        return ""
    if isinstance(payload.get("response"), str):
        return payload["response"]
    choices = payload.get("choices") or []
    message = choices[0].get("message", {}) if choices and isinstance(choices[0], dict) else {}
    return message.get("content", "") if isinstance(message.get("content"), str) else ""


def records(value: Any) -> list[dict]:
    return [entry for entry in value if isinstance(entry, dict)] if isinstance(value, list) else []


def completion(payload: Any, model: str) -> Completion:
    data = payload if isinstance(payload, dict) else {}
    usage = data.get("usage")

    def count(value):
        return (
            value if isinstance(value, (int, float)) and math.isfinite(value) and value >= 0 else 0
        )

    parsed_usage = (
        None
        if not isinstance(usage, dict)
        else {
            "prompt_tokens": count(usage.get("prompt_tokens", usage.get("input_tokens"))),
            "completion_tokens": count(usage.get("completion_tokens", usage.get("output_tokens"))),
            "total_tokens": count(usage.get("total_tokens")),
        }
    )
    result = Completion(extract_text(payload), data.get("model") or model, parsed_usage)
    if data.get("output") or data.get("output_text"):
        parts = [
            part
            for output in records(data.get("output"))
            for part in records(output.get("content"))
        ]
        result.content = (
            data.get("output_text")
            or "\n\n".join(p["text"] for p in parts if isinstance(p.get("text"), str))
            or result.content
        )
    return result


class Inference:
    def __init__(self, env: Any):
        self.env = env

    async def binding(self, model: str, data: dict, gateway_id: str | None, metadata: dict):
        args = [model, data]
        if gateway_id:
            args.append({"gateway": {"id": gateway_id, "metadata": metadata}})
        return to_python(await self.env.AI.run(*args))

    async def chat(
        self, config: ModelConfig, messages: list[dict], attribution: Attribution
    ) -> Completion:
        source_id = f"aigreq:{uuid.uuid4()}"
        metadata = {**attribution.metadata(source_id), "ragbot_settings_revision": config.revision}
        body = {
            "messages": messages,
            "temperature": config.temperature,
        }
        if not config.temperature_supported:
            body.pop("temperature")
        # Reasoning models reject sampling controls.
        if re.match(r"openai/(?:gpt-[5-9]|o[1-9])", config.model):
            body.pop("temperature", None)
        if config.api_format == "responses":
            payload = await self.binding(
                config.model,
                {
                    "input": messages,
                    **({"temperature": body["temperature"]} if "temperature" in body else {}),
                    **(
                        {"reasoning": {"effort": config.reasoning_effort}}
                        if config.reasoning_effort
                        else {}
                    ),
                },
                config.gateway_id,
                metadata,
            )
        else:
            if config.reasoning_effort:
                body["reasoning_effort"] = config.reasoning_effort
            payload = await self.binding(config.model, body, config.gateway_id, metadata)
        return completion(payload, config.model)

    async def media(
        self,
        profile: dict,
        data: dict,
        attribution: Attribution,
        *,
        settings_revision: str = "unspecified",
    ):
        source_id = f"aigreq:{uuid.uuid4()}"
        result = await self.binding(
            profile["model"],
            data,
            profile.get("gatewayId"),
            {**attribution.metadata(source_id), "ragbot_settings_revision": settings_revision},
        )
        return result
