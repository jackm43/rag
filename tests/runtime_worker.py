"""Test-only worker assembled in a temporary directory; never deployed."""

import asyncio
import json
from urllib.parse import urlparse

from production import Default as ProductionDefault
from production import DiscordGateway as ProductionGateway
from workers import Response

from ragbot.app import Application
from ragbot.gateway import Socket, gateway_stub


class Default(ProductionDefault):
    async def fetch(self, request):
        path = urlparse(request.url).path
        if path == "/test/media":
            return Response(b"image-bytes", headers={"content-type": "image/png"})
        if path == "/test/upstream":
            return Response.json(
                {
                    "model": "test-model",
                    "choices": [
                        {
                            "message": {
                                "content": "Assistant: hello <@123456789012345678> https://example.com"
                            }
                        }
                    ],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
                }
            )
        if path == "/test/gateway":
            return Response.json(
                await gateway_stub(self.env).probe(
                    request.url.replace("/test/gateway", "/test/socket").replace("http://", "ws://")
                )
            )
        if path == "/test/socket":
            from js import Object, WebSocketPair
            from pyodide.ffi import create_proxy

            pair = WebSocketPair.new()
            client, server = Object.values(pair)
            server.accept()

            def received(event):
                payload = json.loads(event.data)
                if payload["op"] == 1:
                    server.send(json.dumps({"op": 11}))
                if payload["op"] == 2:
                    server.send(
                        json.dumps(
                            {
                                "op": 0,
                                "s": 1,
                                "t": "READY",
                                "d": {
                                    "session_id": "test-session",
                                    "resume_gateway_url": "wss://gateway.discord.gg",
                                    "user": {"id": "123456789012345678"},
                                },
                            }
                        )
                    )
                    message = json.dumps(
                        {
                            "op": 0,
                            "s": 2,
                            "t": "MESSAGE_CREATE",
                            "d": {
                                "id": "123456789012345699",
                                "channel_id": "123456789012345681",
                                "content": "hello",
                            },
                        }
                    )
                    server.send(message)
                    server.send(message)

            server.addEventListener("message", create_proxy(received))
            server.send(json.dumps({"op": 10, "d": {"heartbeat_interval": 100}}))
            return Response(status=101, web_socket=client)
        if path != "/test/scenario":
            return await super().fetch(request)
        calls = []

        async def transport(url, **options):
            data = json.loads(options["body"]) if isinstance(options.get("body"), str) else None
            calls.append({"url": url, "method": options.get("method", "GET"), "data": data})
            if "gateway.ai.cloudflare.com" in url:
                from ragbot.runtime import fetch

                return await fetch(
                    request.url.replace("/test/scenario", "/test/upstream"), **options
                )
            if url.endswith("/threads"):
                return Response.json({"id": "123456789012345690", "type": 11})
            return Response.json({"id": "123456789012345691", "type": 0})

        from ragbot.discord import download_media

        media, mime = await download_media(request.url.replace("/test/scenario", "/test/media"))
        assert media == b"image-bytes" and mime == "image/png"
        app = Application(self.env, transport=transport)
        await app.db.batch([("SELECT 1 AS value", ())])
        interaction = {
            "id": "123456789012345680",
            "type": 2,
            "application_id": self.env.DISCORD_APPLICATION_ID,
            "token": "test-webhook",
            "guild_id": "457689460096630794",
            "channel_id": "123456789012345681",
            "member": {"user": {"id": "123456789012345679", "username": "tester"}},
            "data": {
                "name": "rag",
                "options": [{"name": "user", "value": "123456789012345682"}],
                "resolved": {"users": {"123456789012345682": {"username": "target"}}},
            },
        }
        await app.dispatch(interaction)
        interaction["data"] = {
            "name": "ask",
            "options": [{"name": "prompt", "value": "explain trees"}],
        }
        await app.dispatch(interaction)
        from ragbot.discord import Attachment

        async def multipart(url, **options):
            file = options["body"].get("files[0]")
            assert file.size == 3
            assert file.type == "image/png"
            return Response.json({})

        app.discord.transport = multipart
        await app.discord.write_interaction(
            "app", "token", "image", files=(Attachment("test.png", "image/png", b"abc"),)
        )
        return Response.json(
            {
                "calls": calls,
                "totals": await app.db.all("SELECT * FROM rag_totals"),
                "threads": await app.db.all("SELECT * FROM rag_ai_threads"),
                "interactions": await app.db.all("SELECT * FROM rag_ai_interactions"),
                "spend": await app.db.all("SELECT * FROM rag_ai_spend_events"),
                "multipart": True,
            }
        )


class DiscordGateway(ProductionGateway):
    async def probe(self, url):
        processed = []

        async def handle(message, bot_user_id):
            processed.append(message["id"])

        self.gateway.app.handle_message = handle
        self.gateway.socket_factory = lambda ignored, *callbacks: Socket(url, *callbacks)
        await self.gateway.start()
        for _ in range(100):
            if processed:
                break
            await asyncio.sleep(0.05)
        await asyncio.sleep(0.25)
        result = {
            "health": await self.gateway.health(),
            "processed": processed,
            "sequence": self.gateway.sequence,
            "heartbeat": self.gateway.heartbeat_acknowledged,
        }
        await self.gateway.stop()
        result["stopped"] = await self.gateway.ensure_connected()
        await self.gateway.alarm()
        return result
