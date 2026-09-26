"""Isolated local compatibility probe. Never imported by production code."""

import asyncio
import json
from urllib.parse import urlsplit

import aiohttp
import discord
from workers import Response, WorkerEntrypoint


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        url = urlsplit(request.url)
        path = url.path
        origin = f"{url.scheme}://{url.netloc}"
        if path == "/peer":
            return Response('{"ok":true}', headers={"content-type": "application/json"})
        if path == "/ws":
            from js import Object, WebSocketPair
            from js import Response as JSResponse
            from pyodide.ffi import to_js

            client, server = Object.values(WebSocketPair.new())
            server.accept()
            server.send('{"op":10,"d":{"heartbeat_interval":60000}}')
            return JSResponse.new(
                None, to_js({"status": 101, "webSocket": client}, dict_converter=Object.fromEntries)
            )
        result = {"discord": discord.__version__, "aiohttp": aiohttp.__version__}

        async def test(name, coro):
            try:
                result[name] = await asyncio.wait_for(coro, 5)
            except Exception as exc:
                result[name] = {"error": type(exc).__name__, "message": str(exc)}

        async def http():
            async with aiohttp.ClientSession() as session:
                async with session.get(origin + "/peer") as response:
                    return await response.json()

        async def heartbeat():
            from discord.gateway import DiscordWebSocket

            async with aiohttp.ClientSession() as session:
                async with session.ws_connect(origin + "/ws") as socket:
                    gateway = DiscordWebSocket(socket, loop=asyncio.get_running_loop())
                    gateway._max_heartbeat_timeout = 5
                    gateway.shard_id = None
                    await gateway.poll_event()
                    return True

        async def client():
            async with discord.Client(intents=discord.Intents.none()):
                return {"constructed": True}

        async def websocket():
            async with aiohttp.ClientSession() as session:
                async with session.ws_connect(origin + "/ws") as ws:
                    return await ws.receive_json()

        await test("websocket", websocket())
        await test("http", http())
        await test("heartbeat", heartbeat())
        await test("client", client())
        return Response(json.dumps(result), headers={"content-type": "application/json"})
