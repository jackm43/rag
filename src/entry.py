"""Cloudflare Python Worker and the existing DiscordGateway Durable Object."""

import json
import logging
from urllib.parse import urlparse

from workers import DurableObject, Response, WorkerEntrypoint

from ragbot.app import Application
from ragbot.gateway import Gateway, gateway_stub
from ragbot.runtime import wait_until
from ragbot.security import authorize_control, verify_discord_signature

log = logging.getLogger("ragbot")


class Default(WorkerEntrypoint):
    def __init__(self, ctx, env):
        super().__init__(ctx, env)
        self.app = Application(env)

    async def fetch(self, request):
        path = urlparse(request.url).path
        if request.method == "POST" and path == "/interactions":
            # Verify the exact bytes Discord signed before JSON decoding or dispatch.
            body = await request.bytes()
            valid = await verify_discord_signature(
                getattr(self.env, "DISCORD_PUBLIC_KEY", ""),
                request.headers.get("x-signature-ed25519"),
                request.headers.get("x-signature-timestamp"),
                body,
            )
            if not valid:
                log.warning("interaction_signature_denied")
                return Response(status=401)
            try:
                interaction = json.loads(body)
            except ValueError, UnicodeError:
                log.warning("interaction_body_unparseable")
                return Response(status=400)
            if not isinstance(interaction, dict) or isinstance(interaction.get("type"), bool):
                return Response(status=400)
            if interaction.get("type") == 1:
                return Response.from_json({"type": 1})
            if interaction.get("type") != 2:
                return Response(status=400)
            wait_until(self.ctx, self.app.dispatch(interaction))
            return Response.from_json({"type": 5})
        controls = {
            ("POST", "/gateway/start"): "start",
            ("POST", "/gateway/stop"): "stop",
            ("GET", "/gateway/health"): "health",
        }
        action = controls.get((request.method, path))
        if action:
            denial = authorize_control(
                getattr(self.env, "GATEWAY_CONTROL_TOKEN", None),
                request.headers.get("authorization"),
            )
            if denial:
                log.warning("gateway_control_denied status=%s", denial)
                return Response(status=denial)
            result = await getattr(gateway_stub(self.env), action)()
            return Response.from_json(result)
        return Response(status=404)

    async def scheduled(self, controller, env, ctx):
        try:
            await gateway_stub(self.env).ensure_connected()
        except Exception:
            log.error("gateway_ensure_connected_failed")


class DiscordGateway(DurableObject):
    def __init__(self, ctx, env):
        super().__init__(ctx, env)
        self.gateway = Gateway(self.ctx, env, Application(env))

    async def start(self):
        return await self.gateway.start()

    async def stop(self):
        return await self.gateway.stop()

    async def health(self):
        return await self.gateway.health()

    async def ensure_connected(self):
        return await self.gateway.ensure_connected()

    async def alarm(self):
        await self.gateway.alarm()
