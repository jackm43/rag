"""Shared editable settings and per-request configuration snapshots."""

import json

from ._bundled import FILES
from .config import ConfigStore, resource_revision


class DraftNamespace:
    def __init__(self, overrides, resources=None):
        self.values = dict(FILES if resources is None else resources)
        self.values.update(overrides.get("kv") or {})
        for key, fields in [
            (
                "discord-response.json",
                {
                    **{k: k for k in ("model", "temperature", "maxTokens", "historyLimit")},
                    "apiFormat": "chatApiFormat",
                    "temperatureSupported": "chatTemperatureSupported",
                },
            ),
            (
                "ask-web-search.json",
                {
                    "model": "webSearchModel",
                    "maxOutputTokens": "webSearchMaxTokens",
                    "searchContextSize": "webSearchContextSize",
                },
            ),
        ]:
            try:
                document = json.loads(self.values.get(key, FILES[key]))
                if not isinstance(document, dict):
                    document = {}
            except ValueError, TypeError:
                document = {}
            for field, source in fields.items():
                value = overrides.get(source)
                if value is not None and value != "":
                    document[field] = value
            if key == "ask-web-search.json" and overrides.get("webSearchModel"):
                document["apiFormat"] = "responses"
            self.values[key] = json.dumps(document)

        for field, key in (
            ("systemPrompt", "discord-response-system-prompt.md"),
            ("webSearchSystemPrompt", "ask-web-search-system-prompt.md"),
        ):
            if isinstance(overrides.get(field), str) and overrides[field].strip():
                self.values[key] = overrides[field]
        image = json.loads(self.values.get("bicture-image.json", FILES["bicture-image.json"]))
        profile_name = overrides.get("imageProfile") or image["activeProfile"]
        if profile_name not in image["profiles"]:
            raise ValueError("unknown image profile")
        image["activeProfile"] = profile_name
        profile = image["profiles"][profile_name]
        for field, source in (
            ("model", "imageModel"),
            ("aspectRatio", "imageAspectRatio"),
            ("quality", "imageQuality"),
            ("resolution", "imageResolution"),
        ):
            if overrides.get(source):
                profile[field] = overrides[source]
        if "imageParameters" in overrides:
            profile["parameters"] = overrides["imageParameters"]
        self.values["bicture-image.json"] = json.dumps(image)

    async def get(self, key):
        return self.values.get(key)


def draft_store(overrides, resources=None, revision=None):
    baseline = FILES if resources is None else resources
    values = DraftNamespace(overrides, baseline).values
    checksum = resource_revision(values)
    base_revision = revision or "legacy-" + resource_revision(baseline)
    used_revision = (
        base_revision
        if checksum == resource_revision(baseline)
        else base_revision + "+draft-" + checksum[:12]
    )
    return ConfigStore(
        None,
        snapshot={
            "schemaVersion": 1,
            "resources": values,
            "revision": used_revision,
            "source": "draft",
        },
    )


async def resolve_config(overrides, resources=None):
    store = draft_store(overrides, resources)
    chat, search = await store.models()
    image = await store.document("bicture-image.json")
    return {
        "image": image,
        "responseModel": chat.model,
        "chatApiFormat": chat.api_format,
        "systemPrompt": chat.prompt,
        "maxTokens": chat.max_tokens,
        "temperature": chat.temperature,
        "historyLimit": chat.history_limit,
        "gatewayId": chat.gateway_id,
        "askWebSearchModel": search.model,
        "askWebSearchApiFormat": search.api_format,
        "askWebSearchSystemPrompt": search.prompt,
        "askWebSearchMaxOutputTokens": search.max_tokens,
        "askWebSearchTemperature": search.temperature,
        "askWebSearchMaxTurns": search.max_turns,
        "askWebSearchContextSize": search.search_context_size,
        "askWebSearchGatewayId": search.gateway_id,
    }


def validate_overrides(overrides):
    """Reject malformed drafts before they become persistent configuration."""
    import math

    strings = {
        "model",
        "chatApiFormat",
        "webSearchModel",
        "systemPrompt",
        "webSearchSystemPrompt",
        "imageProfile",
        "imageModel",
        "imageAspectRatio",
        "imageQuality",
        "imageResolution",
        "webSearchContextSize",
    }
    numeric = {
        "temperature": (0, 2),
        "maxTokens": (1, 32768),
        "historyLimit": (1, 100),
        "webSearchMaxTokens": (1, 32768),
    }
    if set(overrides) - strings - numeric.keys():
        raise ValueError("unknown setting")
    if overrides.get("chatApiFormat") not in (None, "chat-completions", "responses"):
        raise ValueError("invalid chat API format")
    if overrides.get("webSearchContextSize") not in (None, "", "low", "medium", "high"):
        raise ValueError("invalid search context size")
    for key, value in overrides.items():
        if key in strings:
            if not isinstance(value, str) or len(value) > 100000:
                raise ValueError("invalid setting text")
        else:
            low, high = numeric[key]
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
                or not low <= value <= high
                or (key != "temperature" and int(value) != value)
            ):
                raise ValueError("invalid numeric setting")
