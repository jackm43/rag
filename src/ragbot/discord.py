"""Small async Discord REST client using the Workers Fetch transport."""

import json
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from .discord_http import DiscordHTTP
from .policy import truncate_discord
from .runtime import fetch, to_js

API_BASE = "https://discord.com/api/v10"
MEDIA_MAX_BYTES = 25 * 1024 * 1024
log = logging.getLogger("ragbot")
Transport = Callable[..., Awaitable[Any]]


class MediaTooLargeError(ValueError):
    pass


@dataclass(frozen=True)
class Attachment:
    name: str
    content_type: str
    data: bytes


async def download_media(url: str, *, transport: Transport = fetch) -> tuple[bytes, str | None]:
    response = await transport(url, timeout_ms=30000)
    if not response.ok:
        raise RuntimeError(f"media download failed ({response.status})")
    body = response.js_response.body
    try:
        length = int(response.headers.get("content-length") or "0")
    except ValueError:
        length = 0
    if length > MEDIA_MAX_BYTES:
        if body:
            await body.cancel()
        raise MediaTooLargeError("media response exceeds 25 MiB")
    return await read_media(body), response.headers.get("content-type")


async def read_media(body) -> bytes:
    """Bound streaming images and downloads before copying each chunk into Python."""
    if not body:
        return b""
    reader, data = body.getReader(), bytearray()
    try:
        while True:
            result = await reader.read()
            if result.done:
                return bytes(data)
            if len(data) + result.value.byteLength > MEDIA_MAX_BYTES:
                await reader.cancel()
                raise MediaTooLargeError("media response exceeds 25 MiB")
            data.extend(result.value.to_py())
    finally:
        reader.releaseLock()


@dataclass
class DiscordClient:
    token: str
    transport: Transport = fetch
    _role_cache: dict = field(default_factory=dict)
    _http: DiscordHTTP = field(default_factory=DiscordHTTP)

    async def request(
        self, path: str, *, method: str = "GET", data: Any = None, headers: dict | None = None
    ):
        options: dict = {
            "method": method,
            "headers": {"authorization": f"Bot {self.token}", **(headers or {})},
        }
        if data is not None:
            options["body"] = json.dumps(data)
            options["headers"]["content-type"] = "application/json"
        return await self._http.send(self.transport, API_BASE + path, **options)

    async def json_request(self, path: str, *, optional: bool = False, **options):
        response = await self.request(path, **options)
        if not response.ok:
            if optional:
                return None
            raise RuntimeError(f"Discord API request failed ({response.status})")
        try:
            return await response.json()
        except Exception:
            return None

    async def post_message(self, channel_id: str, content: str, *, reply_to: str | None = None):
        data: dict = {"content": content, "allowed_mentions": {"parse": []}}
        if reply_to:
            data["message_reference"] = {"message_id": reply_to, "fail_if_not_exists": False}
            data["allowed_mentions"]["replied_user"] = False
        return await self.request(
            f"/channels/{channel_id}/messages",
            method="POST",
            data=data,
        )

    async def message(self, channel_id: str, message_id: str):
        return await self.json_request(
            f"/channels/{channel_id}/messages/{message_id}", optional=True
        )

    async def username(self, user_id: str) -> str | None:
        try:
            user = await self.json_request(f"/users/{user_id}", optional=True)
            return user["username"] if user else None
        except Exception:
            return None

    async def bot_roles(self, guild_id: str, bot_user_id: str) -> list[str]:
        key = (guild_id, bot_user_id)
        roles, expires = self._role_cache.get(key, ([], 0))
        if expires > time.monotonic():
            return roles
        try:
            member = await self.json_request(
                f"/guilds/{guild_id}/members/{bot_user_id}", optional=True
            )
            if member is None:
                return roles
            roles = member["roles"]
            self._role_cache[key] = (roles, time.monotonic() + 300)
        except Exception:
            pass
        return roles

    async def write_interaction(
        self,
        application_id: str,
        token: str,
        content: str,
        *,
        edit: bool = True,
        users: list[str] | None = None,
        files: tuple[Attachment, ...] = (),
    ) -> bool:
        # Webhook tokens authenticate this route. Never send the bot credential here.
        data: dict = {"content": truncate_discord(content, 2000), "allowed_mentions": {"parse": []}}
        if users:
            data["allowed_mentions"]["users"] = users
        options: dict = {"method": "PATCH" if edit else "POST"}
        if files:
            from js import Blob, FormData

            form = FormData.new()
            data["attachments"] = [
                {"id": str(i), "filename": file.name} for i, file in enumerate(files)
            ]
            form.append("payload_json", json.dumps(data))
            for i, file in enumerate(files):
                form.append(
                    f"files[{i}]",
                    Blob.new(to_js([to_js(file.data)]), to_js({"type": file.content_type})),
                    file.name,
                )
            options["body"] = form
        else:
            options.update(headers={"content-type": "application/json"}, body=json.dumps(data))
        suffix = "/messages/@original" if edit else ""
        response = await self._http.send(
            self.transport, f"{API_BASE}/webhooks/{application_id}/{token}{suffix}", **options
        )
        if not response.ok:
            code = None
            try:
                error = await response.json()
                if isinstance(error, dict) and isinstance(error.get("code"), int):
                    code = error["code"]
            except Exception:
                pass
            log.warning("interaction_write_rejected status=%s code=%s", response.status, code)
        return response.ok
