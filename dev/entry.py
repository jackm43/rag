"""Local-only UI. Staged separately so production never imports dev code."""

from urllib.parse import urlparse

from dev_assets import ASSETS
from harness import Simulation, resolve_config
from workers import Response, WorkerEntrypoint

from ragbot.commands import COMMANDS
from ragbot.runtime import env_value


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        if env_value(self.env, "DEV_UI") != "1":
            return Response(status=404)
        path = urlparse(request.url).path
        if request.method == "GET" and path in ASSETS:
            body, mime = ASSETS[path]
            return Response(
                body,
                headers={"content-type": mime + "; charset=utf-8", "cache-control": "no-store"},
            )
        if request.method == "GET" and path == "/api/meta":
            return Response.json(
                {
                    "applicationId": self.env.DISCORD_APPLICATION_ID,
                    "guildId": self.env.ALLOWED_GUILD_IDS.split(",")[0].strip(),
                    "hasAigToken": bool(env_value(self.env, "CF_AIG_TOKEN")),
                    "config": await resolve_config({}),
                    "commands": [
                        dict(c.data, adminOnly=c.admin_only, requiredRoleId=c.required_role_id)
                        for c in COMMANDS.values()
                    ],
                }
            )
        if request.method != "POST":
            return Response(status=404)
        try:
            body = await request.json()
            if not isinstance(body, dict):
                raise ValueError("expected a JSON object body")
            if path == "/api/config":
                return Response.json(await resolve_config(body.get("overrides") or {}))
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
            if body.get("mode") not in ("thread", "ask_thread"):
                body["mode"] = "channel"
            if path == "/api/mention" and not env_value(self.env, "CF_AIG_TOKEN"):
                return Response.json(
                    {"error": "CF_AIG_TOKEN is not set; restart via pnpm run dev:ui."}, status=503
                )
            return Response.json(await Simulation(self.env, body).run(path.rsplit("/", 1)[-1]))
        except ValueError, TypeError, KeyError:
            return Response.json({"error": "Invalid simulation input."}, status=400)
        except Exception:
            return Response.json(
                {"error": "Simulation failed. Check the local worker logs."}, status=500
            )
