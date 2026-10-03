"""Local-only UI. Staged separately so production never imports dev code."""

import hashlib
import json
from urllib.parse import urlparse

from dev_assets import ASSETS
from harness import Simulation
from model_catalog import (
    CatalogUnavailable,
    CreditCatalog,
    ModelUnavailable,
    chat_overrides,
    image_parameters,
)
from settings import resolve_config, validate_overrides
from settings_api import SettingsEditor, SettingsError
from workers import Response, WorkerEntrypoint

from ragbot.commands import COMMANDS
from ragbot.commands.registry import ADMIN_IDS

REVISION = hashlib.sha256(json.dumps(ASSETS, sort_keys=True).encode()).hexdigest()


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        if getattr(self.env, "DEV_UI", None) != "1":
            return Response(status=404)
        url = urlparse(request.url)
        if url.hostname not in ("localhost", "127.0.0.1", "::1"):
            return Response(status=403)
        path = url.path
        if request.method == "GET" and path in ASSETS:
            body, mime = ASSETS[path]
            return Response(
                body,
                headers={"content-type": mime + "; charset=utf-8", "cache-control": "no-store"},
            )
        if request.method == "GET" and path == "/api/revision":
            return Response.json({"revision": REVISION})
        if request.method == "GET" and path == "/api/meta":
            try:
                current = await SettingsEditor(self.env, "live").read()
            except SettingsError as error:
                return Response.json({"error": error.message}, status=error.status)
            return Response.json(
                {
                    "revision": REVISION,
                    "defaults": {
                        "userId": sorted(ADMIN_IDS)[0],
                        "username": "dev_user",
                        "globalName": "Dev User",
                        "channelId": "123456789012345678",
                    },
                    "applicationId": self.env.DISCORD_APPLICATION_ID,
                    "guildId": self.env.ALLOWED_GUILD_IDS.split(",")[0].strip(),
                    "config": current["config"],
                    "commands": [
                        dict(c.data, adminOnly=c.admin_only, requiredRoleId=c.required_role_id)
                        for c in COMMANDS.values()
                    ],
                }
            )
        if request.method == "GET" and path == "/api/models":
            try:
                current = await SettingsEditor(self.env, "live").read()
                return Response.json(await CreditCatalog(self.env).load(current["config"]))
            except Exception:
                return Response.json(
                    {"error": "Cannot verify Cloudflare-credit models. Retry the model list."},
                    status=503,
                )
        if request.method != "POST":
            return Response(status=404)
        if (
            request.headers.get("origin") != f"{url.scheme}://{url.netloc}"
            or request.headers.get("x-ragbot-ui") != "1"
            or (request.headers.get("content-type") or "").split(";")[0] != "application/json"
        ):
            return Response(status=403)
        try:
            body = await request.json()
            if not isinstance(body, dict):
                raise ValueError("expected a JSON object body")
            editor = SettingsEditor(self.env, body.get("target", "local"))
            if path == "/api/history":
                return Response.json(
                    await editor.history(body), headers={"cache-control": "no-store"}
                )
            if path == "/api/settings/load":
                return Response.json(await editor.read())
            if path == "/api/settings/review":
                return Response.json(await editor.preview(body))
            if path == "/api/settings/save":
                return Response.json(await editor.save(body))
            baseline = await editor.read()
            if body.get("baseRevision") and body["baseRevision"] != baseline["revision"]:
                raise SettingsError(
                    "Settings changed since you loaded them. Reload before testing.", 409
                )
            resources = baseline["resources"]
            body["baseResources"] = resources
            body["settingsRevision"] = baseline["revision"]
            catalog = CreditCatalog(self.env)
            if path == "/api/models":
                return Response.json(
                    await catalog.load(
                        await resolve_config({}, resources), refresh=bool(body.get("refresh"))
                    )
                )
            overrides = dict(body.get("overrides") or {})
            # Only server-verified image parameters may reach the real handler.
            overrides.pop("imageParameters", None)
            overrides.pop("chatApiFormat", None)
            overrides.pop("chatTemperatureSupported", None)
            validate_overrides(overrides)
            config = await resolve_config(overrides, resources)
            if body.get("command") == "bicture" or body.get("page") == "bicture":
                available = await catalog.validate(config, ["image"])
                profile = config["image"]["profiles"][config["image"]["activeProfile"]]
                model = next(m for m in available["image"] if m["id"] == profile["model"])
                overrides["imageParameters"] = image_parameters(model, profile, overrides)
                config = await resolve_config(overrides, resources)
            elif path == "/api/mention":
                available = await catalog.validate(config, ["chat"])
                selected = next(m for m in available["chat"] if m["id"] == config["responseModel"])
                overrides.update(chat_overrides(selected, config, overrides))
            body["overrides"] = overrides
            if path == "/api/config":
                return Response.json(config)
            if path not in ("/api/mention", "/api/interaction"):
                return Response(status=404)
            identity = body.get("identity")
            if not isinstance(identity, dict) or not all(
                isinstance(identity.get(k), str) and identity[k] for k in ("userId", "username")
            ):
                raise ValueError("identity requires userId and username")
            for field in ("channelId", "content" if path == "/api/mention" else "command"):
                if not isinstance(body.get(field), str) or not body[field].strip():
                    raise ValueError(f"{field} is required")
            body["guildId"] = (
                body.get("guildId") or self.env.ALLOWED_GUILD_IDS.split(",")[0].strip()
            )
            body["botUserId"] = body.get("botUserId") or self.env.DISCORD_APPLICATION_ID
            return Response.json(await Simulation(self.env, body).run(path.rsplit("/", 1)[-1]))
        except SettingsError as error:
            return Response.json({"error": error.message}, status=error.status)
        except ModelUnavailable as error:
            return Response.json({"error": str(error)}, status=400)
        except CatalogUnavailable:
            return Response.json(
                {"error": "Cannot verify Cloudflare-credit access. Retry the model list."},
                status=503,
            )
        except ValueError, TypeError, KeyError:
            return Response.json({"error": "Invalid simulation input."}, status=400)
        except Exception:
            return Response.json(
                {"error": "Simulation failed. Check the local worker logs."}, status=500
            )
