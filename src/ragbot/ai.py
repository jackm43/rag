"""Chat and image inference with request attribution."""

import math
import re
import uuid
from dataclasses import dataclass
from typing import Any

from .config import ModelConfig


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
    match payload:
        case str(text):
            return text
        case {"output_text": str(text)} if text:
            return text
        case {"output": list(outputs)} if outputs:
            parts = []
            for output in outputs:
                if output.get("type") != "message":
                    continue
                for part in output.get("content", []):
                    if part.get("type") == "output_text":
                        parts.append(part["text"])
            return "\n\n".join(parts)
        case {"response": str(text)}:
            return text
        case {"choices": [{"message": {"content": str(text)}}, *_]}:
            return text
        case _:
            return ""


def completion(payload: Any, model: str) -> Completion:
    data = payload if isinstance(payload, dict) else {}
    usage = data.get("usage")

    def count(value):
        if isinstance(value, (int, float)) and math.isfinite(value) and value >= 0:
            return value
        return 0

    parsed_usage = None
    if isinstance(usage, dict):
        parsed_usage = {
            "prompt_tokens": count(usage.get("prompt_tokens", usage.get("input_tokens"))),
            "completion_tokens": count(usage.get("completion_tokens", usage.get("output_tokens"))),
            "total_tokens": count(usage.get("total_tokens")),
        }
    return Completion(extract_text(payload), data.get("model") or model, parsed_usage)


class Inference:
    def __init__(self, env: Any):
        self.env = env

    async def binding(self, model: str, data: dict, gateway_id: str | None, metadata: dict):
        if gateway_id:
            return await self.env.AI.run(
                model, data, {"gateway": {"id": gateway_id, "metadata": metadata}}
            )
        return await self.env.AI.run(model, data)

    async def chat(
        self, config: ModelConfig, messages: list[dict], attribution: Attribution
    ) -> Completion:
        source_id = f"aigreq:{uuid.uuid4()}"
        metadata = {**attribution.metadata(source_id), "ragbot_settings_revision": config.revision}
        body: dict
        match config.api_format:
            case "responses":
                body = {"input": messages}
                if config.reasoning_effort:
                    body["reasoning"] = {"effort": config.reasoning_effort}
            case "chat-completions":
                body = {"messages": messages}
                if config.reasoning_effort:
                    body["reasoning_effort"] = config.reasoning_effort
            case _:
                raise ValueError("unsupported chat API format")
        # Reasoning models reject sampling controls.
        if config.temperature_supported and not re.match(
            r"openai/(?:gpt-[5-9]|o[1-9])", config.model
        ):
            body["temperature"] = config.temperature
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
        return await self.binding(
            profile["model"],
            data,
            profile.get("gatewayId"),
            {**attribution.metadata(source_id), "ragbot_settings_revision": settings_revision},
        )
