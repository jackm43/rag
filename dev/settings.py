"""Shared editable settings and per-request configuration snapshots."""

import hashlib
import json

from ragbot.config import ConfigStore


def resource_revision(resources: dict) -> str:
    normalized = {
        key: json.loads(value) if key.endswith(".json") else value
        for key, value in resources.items()
    }
    return hashlib.sha256(json.dumps(normalized, sort_keys=True).encode()).hexdigest()


class DraftNamespace:
    def __init__(self, overrides, resources):
        self.values = dict(resources)
        document = json.loads(self.values["discord-response.json"])
        if overrides.get("model") and overrides["model"] != document.get("model"):
            # Reasoning support is model-specific; do not carry it to another model.
            document.pop("reasoningEffort", None)
        for field, source in {
            **{k: k for k in ("model", "temperature", "historyLimit")},
            "apiFormat": "chatApiFormat",
            "temperatureSupported": "chatTemperatureSupported",
        }.items():
            value = overrides.get(source)
            if value is not None and value != "":
                document[field] = value
        self.values["discord-response.json"] = json.dumps(document)
        prompt = overrides.get("systemPrompt")
        if isinstance(prompt, str) and prompt.strip():
            self.values["discord-response-system-prompt.md"] = prompt
        image = json.loads(self.values["bicture-image.json"])
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


def draft_store(overrides, resources, revision=None):
    baseline = resources
    values = DraftNamespace(overrides, baseline).values
    checksum = resource_revision(values)
    base_revision = revision or "snapshot-" + resource_revision(baseline)
    used_revision = (
        base_revision
        if checksum == resource_revision(baseline)
        else base_revision + "+draft-" + checksum[:12]
    )
    return ConfigStore(
        None,
        snapshot={
            "schemaVersion": 2,
            "resources": values,
            "revision": used_revision,
            "source": "draft",
        },
    )


async def resolve_config(overrides, resources):
    store = draft_store(overrides, resources)
    chat = await store.chat()
    image = await store.document("bicture-image.json")
    return {
        "image": image,
        "responseModel": chat.model,
        "chatApiFormat": chat.api_format,
        "chatReasoningEffort": chat.reasoning_effort,
        "systemPrompt": chat.prompt,
        "temperature": chat.temperature,
        "historyLimit": chat.history_limit,
        "gatewayId": chat.gateway_id,
    }


def validate_overrides(overrides):
    """Reject malformed drafts before they become persistent configuration."""
    import math

    strings = {
        "model",
        "chatApiFormat",
        "systemPrompt",
        "imageProfile",
        "imageModel",
        "imageAspectRatio",
        "imageQuality",
        "imageResolution",
    }
    numeric = {
        "temperature": (0, 2),
        "historyLimit": (1, 100),
    }
    if set(overrides) - strings - numeric.keys():
        raise ValueError("unknown setting")
    if overrides.get("chatApiFormat") not in (None, "chat-completions", "responses"):
        raise ValueError("invalid chat API format")
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
