"""Credit-funded models compatible with the application's existing request shapes.

Sources: https://developers.cloudflare.com/ai-gateway/features/unified-billing/
https://developers.cloudflare.com/ai-gateway/usage/chat-completion/
The account catalog confirms availability; adapters deliberately limit this list
rather than offering every provider/model the gateway can proxy with BYOK.
"""

import asyncio
import re
import time
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import quote

from .runtime import env_value, fetch

# Existing /compat chat requests send messages, max_tokens and temperature.
# Reasoning-only/Responses models need a different request shape and stay out.
CHAT_IDS = {
    "openai/gpt-4.1",
    "openai/gpt-4.1-mini",
    "openai/gpt-4.1-nano",
    "openai/gpt-4o",
    "openai/gpt-4o-mini",
    "google/gemini-2.5-flash",
    "google/gemini-2.5-flash-lite",
    "google/gemini-2.5-pro",
    "xai/grok-4.3",
    "xai/grok-4.5",
    "xai/grok-4.6",
    "xai/grok-4.7",
    "xai/grok-4.20-0309-non-reasoning",
}
# These synchronous image families return an image URL/base64 string, which
# bicture already decodes/downloads with its normal media size cap.
IMAGE_IDS = {
    "xai/grok-imagine-image",
    "xai/grok-imagine-image-quality",
    "xai/grok-imagine-image-2.0",
    "google/nano-banana",
    "google/nano-banana-2",
    "google/nano-banana-pro",
    "google/nano-banana-2-lite",
    "openai/gpt-image-1.5",
    "openai/gpt-image-2",
}
# Cloudflare documents Responses web search for these models.
SEARCH_IDS = {"openai/gpt-4.1", "openai/gpt-4.1-mini", "openai/gpt-4o", "openai/gpt-4o-mini"}
ALIASES = {"xai": {"xai", "grok"}, "google": {"google", "google-ai-studio", "google-vertex-ai"}}
_cache: dict = {}


class CatalogUnavailable(Exception):
    pass


class ModelUnavailable(ValueError):
    pass


@dataclass
class CreditCatalog:
    env: Any
    transport: Callable = fetch

    async def get(self, path):
        account = env_value(self.env, "CF_ACCOUNT_ID")
        token = env_value(self.env, "CLOUDFLARE_API_TOKEN")
        if not token or not isinstance(account, str) or not re.fullmatch(r"[a-f0-9]{32}", account):
            raise CatalogUnavailable()
        response = await self.transport(
            f"https://api.cloudflare.com/client/v4/accounts/{account}/{path}",
            headers={"Authorization": f"Bearer {token}"},
            timeout_ms=15000,
        )
        if not response.ok:
            raise CatalogUnavailable()
        payload = await response.json()
        if not payload.get("success"):
            raise CatalogUnavailable()
        return payload

    async def pages(self, path):
        rows = []
        for page in range(1, 21):
            data = await self.get(f"{path}?per_page=100&page={page}")
            batch = data.get("result")
            if not isinstance(batch, list):
                raise CatalogUnavailable()
            rows.extend(batch)
            info = data.get("result_info", {})
            total = info.get("total_count")
            if (isinstance(total, int) and len(rows) >= total) or not batch:
                return rows
            if total is None and len(batch) < info.get("per_page", 100):
                return rows
        raise CatalogUnavailable()

    async def billing(self, gateway):
        if not isinstance(gateway, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", gateway):
            raise CatalogUnavailable()
        prefix = f"ai-gateway/gateways/{gateway}"
        settings, keys = await asyncio.gather(
            self.get(prefix), self.pages(prefix + "/provider_configs")
        )
        settings = settings["result"]
        # Never return key IDs, previews or other secret-store metadata to the UI.
        blocked = {k["provider_slug"] for k in keys if k.get("alias") == "default"}
        return {
            "unified": settings.get("byok_only") is False,
            "blocked": blocked,
            "workersBilling": settings.get("workers_ai_billing_mode", "unknown"),
        }

    async def load(self, config, *, refresh=False):
        gateways = {
            "chat": config["gatewayId"],
            "search": config["askWebSearchGatewayId"],
            "image": config["image"]["profiles"][config["image"]["activeProfile"]].get("gatewayId"),
        }
        key = (env_value(self.env, "CF_ACCOUNT_ID"), *gateways.values())
        cached = _cache.get(key)
        if not refresh and cached and time.monotonic() - cached[0] < 300:
            return cached[1]
        models = await self.pages("ai/catalog/models")
        billing = dict(
            zip(gateways, await asyncio.gather(*(self.billing(g) for g in gateways.values())))
        )
        result: dict = {
            "chat": [],
            "image": [],
            "search": [],
            "source": "Cloudflare account catalog",
            "checkedAt": int(time.time()),
        }
        for model in models:
            model_id = model.get("model_id", "")
            group = "chat" if model_id in CHAT_IDS else "image" if model_id in IMAGE_IDS else None
            if not group or not credit_route(model, billing[group]):
                continue
            if group == "chat" and (
                model.get("task") != "Text Generation"
                or "chat-completions" not in (model.get("request_formats") or [])
            ):
                continue
            if group == "image" and (
                model.get("task") != "Text-to-Image" or model.get("supports_async")
            ):
                continue
            route = model_id
            if group == "chat":
                route = model_id.replace("xai/", "grok/", 1).replace(
                    "google/", "google-ai-studio/", 1
                )
            result[group].append(
                {
                    "id": route,
                    "catalogId": model_id,
                    "name": model.get("name", model_id),
                    "provider": model["provider_id"],
                    "billingProviders": [
                        p["id"] for p in model.get("provider_details") or [] if p.get("id")
                    ],
                }
            )

        # Resolve the actual supported enums instead of sending Grok parameters
        # to another image provider. Only prompt-only synchronous models qualify.
        async def image_details(model):
            detail = (await self.get("ai/catalog/models/" + quote(model["catalogId"], safe="/")))[
                "result"
            ]
            schema = detail.get("schema", {})
            inputs = schema.get("input", {})
            output = schema.get("output", {}).get("properties", {})
            if set(inputs.get("required", [])) - {"prompt"} or "image" not in output:
                return None
            properties = inputs.get("properties", {})
            model["parameters"] = {
                field: {
                    k: v for k, v in properties[field].items() if k in ("enum", "default", "type")
                }
                for field in ("aspect_ratio", "quality", "resolution", "response_format")
                if field in properties
            }
            return model

        # Small adapter list bounds both concurrency and catalog work.
        result["image"] = [
            m for m in await asyncio.gather(*(image_details(m) for m in result["image"])) if m
        ]
        result["search"] = [
            {"id": m["model_id"], "name": m["name"], "provider": m["provider_id"]}
            for m in models
            if m.get("model_id") in SEARCH_IDS
            and "responses" in (m.get("request_formats") or [])
            and credit_route(m, billing["search"])
        ]
        result["note"] = (
            "Only compatible models using Cloudflare credits are listed. BYOK routes and separately billed Workers AI models are excluded."
        )
        _cache[key] = (time.monotonic(), result)
        return result

    async def validate(self, config, groups):
        catalog = await self.load(config)
        profile = config["image"]["profiles"][config["image"]["activeProfile"]]
        selected = {
            "chat": config["responseModel"],
            "search": config["askWebSearchModel"],
            "image": profile["model"],
        }
        gateways = {
            "chat": config["gatewayId"],
            "search": config["askWebSearchGatewayId"],
            "image": profile.get("gatewayId"),
        }
        for group in groups:
            model = next((m for m in catalog[group] if m["id"] == selected[group]), None)
            if not model:
                raise ModelUnavailable("Select a model from the Cloudflare-credit list.")
            # Recheck routing before inference, even when the catalog is cached.
            billing = await self.billing(gateways[group])
            if not credit_route(
                {
                    "provider_id": model["provider"],
                    "provider_details": [
                        {"id": provider} for provider in model.get("billingProviders", [])
                    ],
                },
                billing,
            ):
                raise ModelUnavailable(
                    "This model cannot use Cloudflare credits with the current gateway settings."
                )
        return catalog


def credit_route(model, billing):
    provider = model.get("provider_id")
    routes = ALIASES.get(provider, {provider})
    routes = routes | {p.get("id") for p in model.get("provider_details") or []}
    return bool(
        provider
        and provider != "workers-ai"
        and billing["unified"]
        and not routes.intersection(billing["blocked"])
    )


def image_parameters(model, profile, overrides):
    params = {}
    for field, source, config_key in (
        ("aspect_ratio", "imageAspectRatio", "aspectRatio"),
        ("quality", "imageQuality", "quality"),
        ("resolution", "imageResolution", "resolution"),
        ("response_format", None, "responseFormat"),
    ):
        spec = model["parameters"].get(field)
        explicit = overrides.get(source) if source else None
        if spec is None:
            if explicit:
                raise ModelUnavailable("The selected image model does not support that setting.")
            continue
        value = explicit or profile.get(config_key)
        if "enum" in spec and value not in spec["enum"]:
            if explicit:
                raise ModelUnavailable("Select an available value for this image model.")
            value = spec.get("default")
        if value:
            params[field] = value
    return params
