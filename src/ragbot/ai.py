"""Inference, request attribution, and shared chat/search routing."""

import json
import logging
import math
import re
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from .config import ConfigStore, ModelConfig
from .db import Database
from .discord import Transport
from .runtime import env_value, fetch, to_python

log = logging.getLogger("ragbot")


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
    sources: list[dict] = field(default_factory=list)
    web_search_calls: int = 0


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


def completion(payload: Any, model: str, *, search: bool = False) -> Completion:
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
    if search:
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
        annotations = [a for p in parts for a in records(p.get("annotations"))]
        for choice in records(data.get("choices")):
            for annotation in records((choice.get("message") or {}).get("annotations")):
                if annotation.get("type") == "url_citation" and isinstance(
                    annotation.get("url_citation"), dict
                ):
                    annotations.append(annotation["url_citation"])
        result.sources = list(
            {a["url"]: a for a in annotations if isinstance(a.get("url"), str)}.values()
        )
        result.web_search_calls = sum(
            item.get("type") == "web_search_call" for item in records(data.get("output"))
        )
    return result


def should_search(prompt: str) -> bool:
    return bool(
        re.search(
            r"\b(search|web search|look up|lookup|google|online|on the web|sources?|cite|citation)\b",
            prompt,
            re.I,
        )
        or re.search(
            r"\b(current|currently|latest|today|now|right now|recent|newest|this week|this month|202[4-9]|news|price|pricing|availability|available|released?|launch(?:ed)?|schedule|law|legal|regulation|market|stock|weather)\b",
            prompt,
            re.I,
        )
        or (
            re.search(
                r"\b(best|top|compare|comparison|versus|vs\.?|recommend|recommendation|buy|worth it)\b",
                prompt,
                re.I,
            )
            and re.search(
                r"\b(gpu|cpu|graphics card|nvidia|amd|intel|apple|laptop|phone|product|model|prices?|availability|performance|benchmark|review)\b",
                prompt,
                re.I,
            )
        )
    )


class Inference:
    def __init__(self, env: Any, db: Database, config: ConfigStore, transport: Transport = fetch):
        self.env, self.db, self.config, self.transport = env, db, config, transport

    async def gateway(self, gateway_id: str, body: dict, metadata: dict):
        account = env_value(self.env, "CF_ACCOUNT_ID")
        if not account:
            raise ValueError("CF_ACCOUNT_ID is required for AI Gateway models")
        response = await self.transport(
            f"https://gateway.ai.cloudflare.com/v1/{account}/{gateway_id}/compat/chat/completions",
            timeout_ms=120000,
            method="POST",
            headers={
                "content-type": "application/json",
                "cf-aig-authorization": f"Bearer {self.env.CF_AIG_TOKEN}",
                "cf-aig-metadata": json.dumps(metadata),
            },
            body=json.dumps(body),
        )
        if not response.ok:
            raise RuntimeError(f"AI Gateway request failed ({response.status})")
        return await response.json()

    async def binding(self, model: str, data: dict, gateway_id: str | None, metadata: dict):
        args = [model.removeprefix("workers-ai/"), data]
        if gateway_id:
            args.append({"gateway": {"id": gateway_id, "metadata": metadata}})
        return to_python(await self.env.AI.run(*args))

    async def chat(
        self, config: ModelConfig, messages: list[dict], attribution: Attribution
    ) -> Completion:
        source_id = f"aigreq:{uuid.uuid4()}"
        metadata = attribution.metadata(source_id)
        body = {
            "messages": messages,
            "max_tokens": config.max_tokens,
            "temperature": config.temperature,
        }
        if config.gateway_id and not config.model.startswith(("@cf/", "workers-ai/")):
            payload = await self.gateway(
                config.gateway_id, {"model": config.model, **body}, metadata
            )
        else:
            payload = await self.binding(config.model, body, config.gateway_id, metadata)
        result = completion(payload, config.model.removeprefix("workers-ai/"))
        return result

    async def search(
        self, config: ModelConfig, prompt: str, attribution: Attribution
    ) -> Completion:
        source_id = f"aigreq:{uuid.uuid4()}"
        metadata = attribution.metadata(source_id)
        if config.gateway_id:
            payload = await self.gateway(
                config.gateway_id,
                {
                    "model": config.model,
                    "messages": [
                        {"role": "system", "content": config.prompt},
                        {"role": "user", "content": prompt},
                    ],
                    "max_tokens": config.max_tokens,
                    "web_search_options": {"search_context_size": config.search_context_size},
                },
                metadata,
            )
        else:
            payload = await self.binding(
                config.model,
                {
                    "input": prompt,
                    "instructions": config.prompt,
                    "max_output_tokens": config.max_tokens,
                    "max_turns": config.max_turns,
                    "temperature": config.temperature,
                    "tools": [
                        {"type": "web_search", "search_context_size": config.search_context_size}
                    ],
                },
                None,
                metadata,
            )
        result = completion(payload, config.model, search=True)
        return result

    async def ask(
        self,
        prompt: str,
        username: str,
        conversation: list[dict],
        attribution: Attribution,
        *,
        web_context: list[dict] | None = None,
    ) -> Completion:
        chat, search = await self.config.models()
        if should_search(prompt):
            lines = [
                f"Current date: {datetime.now(UTC).date()}",
                f"Requester display name: {username}",
                "Discord slash command: /ask",
                "",
            ]
            context = conversation if web_context is None else web_context
            if context:
                lines += [
                    "Thread conversation context:",
                    *(f"{m['role']}: {m['content']}" for m in context),
                    "",
                ]
            lines += ["Current user prompt:", prompt]
            result = await self.search(search, "\n".join(lines), attribution)
            if not re.search(r"https?://", result.content, re.I) and result.sources:
                result.content += "\n\nSources: " + " ".join(
                    f"<{s['url']}>" for s in result.sources[:3]
                )
            return result
        system = (
            chat.prompt
            + "\n\nThis is a /ask thread. Answer using only this thread's conversation context and the current user message; do not use unrelated channel history. Keep the direct, helpful /ask style instead of normal channel banter. Do not include Discord mentions or raw IDs."
        )
        return await self.chat(
            chat, [{"role": "system", "content": system}, *conversation], attribution
        )

    async def media(self, profile: dict, data: dict, attribution: Attribution):
        source_id = f"aigreq:{uuid.uuid4()}"
        result = await self.binding(
            profile["model"], data, profile.get("gatewayId"), attribution.metadata(source_id)
        )
        return result
