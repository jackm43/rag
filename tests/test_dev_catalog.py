from types import SimpleNamespace

import pytest

from ragbot.model_catalog import (
    CatalogUnavailable,
    CreditCatalog,
    ModelUnavailable,
    credit_route,
    image_parameters,
)


@pytest.mark.parametrize("provider", ["openai", "xai", "google"])
def test_credit_filter_requires_unified_billing_and_no_default_key(provider):
    model = {"provider_id": provider}
    assert credit_route(model, {"unified": True, "blocked": set()})
    assert not credit_route(model, {"unified": False, "blocked": set()})
    assert not credit_route(model, {"unified": True, "blocked": {provider}})


def test_credit_filter_checks_aliases_and_actual_provider():
    assert not credit_route({"provider_id": "xai"}, {"unified": True, "blocked": {"grok"}})
    assert not credit_route(
        {"provider_id": "deepseek", "provider_details": [{"id": "fireworks"}]},
        {"unified": True, "blocked": {"fireworks"}},
    )
    assert not credit_route({"provider_id": "workers-ai"}, {"unified": True, "blocked": set()})


def test_image_settings_do_not_leak_between_providers():
    model = {
        "parameters": {
            "aspect_ratio": {"enum": ["1:1", "16:9"]},
            "resolution": {"enum": ["1K", "2K"]},
        }
    }
    profile = {
        "aspectRatio": "auto",
        "quality": "low",
        "resolution": "1k",
        "responseFormat": "b64_json",
    }
    assert image_parameters(model, profile, {}) == {}
    assert image_parameters(
        model, profile, {"imageAspectRatio": "1:1", "imageResolution": "2K"}
    ) == {"aspect_ratio": "1:1", "resolution": "2K"}
    with pytest.raises(ModelUnavailable):
        image_parameters(model, profile, {"imageQuality": "high"})
    with pytest.raises(ModelUnavailable):
        image_parameters(model, profile, {"imageResolution": "1k"})


async def test_account_pagination_and_default_keys_only():
    async def transport(url, **kwargs):
        assert url.startswith("https://api.cloudflare.com/client/v4/accounts/")
        assert kwargs["headers"]["Authorization"] == "Bearer test-only"
        if "provider_configs" in url:
            payload = {
                "success": True,
                "result": [
                    {
                        "provider_slug": "openai",
                        "alias": "testing",
                        "secret_preview": "never-return",
                    },
                    {"provider_slug": "grok", "alias": "default"},
                ],
            }
        elif "catalog" in url:
            page = int(url.rsplit("=", 1)[1])
            payload = {
                "success": True,
                "result": [{"page": page}],
                "result_info": {"total_count": 2},
            }
        else:
            payload = {
                "success": True,
                "result": {"byok_only": False, "workers_ai_billing_mode": "postpaid"},
            }

        async def json():
            return payload

        return SimpleNamespace(ok=True, json=json)

    catalog = CreditCatalog(
        SimpleNamespace(CF_ACCOUNT_ID="a" * 32, CLOUDFLARE_API_TOKEN="test-only"), transport
    )
    assert await catalog.pages("ai/catalog/models") == [{"page": 1}, {"page": 2}]
    billing = await catalog.billing("test")
    assert billing["blocked"] == {"grok"}
    assert "never-return" not in repr(billing)


async def test_catalog_fails_closed_when_cloudflare_rejects_access():
    async def transport(*args, **kwargs):
        return SimpleNamespace(ok=False)

    catalog = CreditCatalog(
        SimpleNamespace(CF_ACCOUNT_ID="a" * 32, CLOUDFLARE_API_TOKEN="test-only"), transport
    )
    with pytest.raises(CatalogUnavailable):
        await catalog.pages("ai/catalog/models")


async def test_catalog_limits_choices_to_compatible_credit_routes(monkeypatch):
    import ragbot.model_catalog as module

    module._cache.clear()
    records = [
        {
            "model_id": "openai/gpt-4.1-mini",
            "provider_id": "openai",
            "task": "Text Generation",
            "request_formats": ["chat-completions"],
        },
        {
            "model_id": "google/gemini-2.5-flash",
            "provider_id": "google",
            "task": "Text Generation",
            "request_formats": ["chat-completions"],
        },
        {
            "model_id": "openai/gpt-5.5-pro",
            "provider_id": "openai",
            "task": "Text Generation",
            "request_formats": ["responses"],
        },
        {
            "model_id": "unlisted/byok-only",
            "provider_id": "unlisted",
            "task": "Text Generation",
            "request_formats": ["chat-completions"],
        },
        {"model_id": "xai/grok-imagine-image", "provider_id": "xai", "task": "Text-to-Image"},
        {"model_id": "google/nano-banana-2", "provider_id": "google", "task": "Text-to-Image"},
    ]
    instance = CreditCatalog(SimpleNamespace(CF_ACCOUNT_ID="unit-test-account"))

    async def pages(path):
        return records

    async def billing(gateway):
        return {"unified": True, "blocked": {"grok"}, "workersBilling": "postpaid"}

    async def get(path):
        return {
            "result": {
                "schema": {
                    "input": {
                        "required": ["prompt"],
                        "properties": {
                            "prompt": {"type": "string"},
                            "resolution": {"enum": ["1K", "2K"]},
                        },
                    },
                    "output": {"properties": {"image": {"type": "string"}}},
                }
            }
        }

    monkeypatch.setattr(instance, "pages", pages)
    monkeypatch.setattr(instance, "billing", billing)
    monkeypatch.setattr(instance, "get", get)
    config = {
        "gatewayId": "test",
        "askWebSearchGatewayId": "test",
        "askWebSearchApiFormat": "responses",
        "image": {"activeProfile": "standard", "profiles": {"standard": {"gatewayId": "test"}}},
    }
    models = await instance.load(config)
    assert {m["id"] for m in models["chat"]} == {
        "openai/gpt-4.1-mini",
        "google-ai-studio/gemini-2.5-flash",
    }
    assert [m["id"] for m in models["image"]] == ["google/nano-banana-2"]
    assert models["image"][0]["parameters"] == {"resolution": {"enum": ["1K", "2K"]}}
    module._cache.clear()
