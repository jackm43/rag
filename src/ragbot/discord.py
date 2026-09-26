"""Small async Discord REST client using the Workers Fetch transport."""

import json
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote, urlencode

from discord_typings import MessageData

from .policy import finalize_ai_reply, truncate_discord
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
    data = bytearray()
    if body:
        reader = body.getReader()
        try:
            while True:
                result = await reader.read()
                if result.done:
                    break
                if len(data) + result.value.byteLength > MEDIA_MAX_BYTES:
                    await reader.cancel()
                    raise MediaTooLargeError("media response exceeds 25 MiB")
                data.extend(result.value.to_py())
        finally:
            reader.releaseLock()
    return bytes(data), response.headers.get("content-type")


def is_message(value: Any, depth: int = 1) -> bool:
    def optional_string(record, key, nullable=False):
        return (
            key not in record or isinstance(record[key], str) or (nullable and record[key] is None)
        )

    def user(record):
        return (
            isinstance(record, dict)
            and all(isinstance(record.get(k), str) for k in ("id", "username"))
            and optional_string(record, "global_name", True)
            and ("bot" not in record or isinstance(record["bot"], bool))
        )

    if not isinstance(value, dict) or not all(
        isinstance(value.get(k), str) for k in ("id", "channel_id")
    ):
        return False
    if not all(optional_string(value, key) for key in ("guild_id", "content")):
        return False
    if "author" in value and not user(value["author"]):
        return False
    if "member" in value:
        member = value["member"]
        if (
            not isinstance(member, dict)
            or not optional_string(member, "nick", True)
            or ("user" in member and not user(member["user"]))
        ):
            return False
    for key in ("mentions", "attachments", "mention_roles"):
        if key in value and not isinstance(value[key], list):
            return False
    if any(not isinstance(role, str) for role in value.get("mention_roles", [])):
        return False
    for mention in value.get("mentions", []):
        if (
            not isinstance(mention, dict)
            or not isinstance(mention.get("id"), str)
            or not optional_string(mention, "username")
        ):
            return False
    for attachment in value.get("attachments", []):
        if (
            not isinstance(attachment, dict)
            or not all(isinstance(attachment.get(k), str) for k in ("id", "filename"))
            or not all(optional_string(attachment, k) for k in ("content_type", "url"))
        ):
            return False
    if "message_reference" in value:
        reference = value["message_reference"]
        if not isinstance(reference, dict) or not all(
            optional_string(reference, k) for k in ("message_id", "channel_id")
        ):
            return False
    reference = value.get("referenced_message")
    return reference is None or (depth > 0 and is_message(reference, depth - 1))


@dataclass
class DiscordClient:
    token: str
    transport: Transport = fetch
    _role_cache: dict = field(default_factory=dict)

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
        return await self.transport(API_BASE + path, **options)

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

    async def post_message(self, channel_id: str, content: str):
        return await self.request(
            f"/channels/{channel_id}/messages",
            method="POST",
            data={"content": content, "allowed_mentions": {"parse": []}},
        )

    async def reply(self, channel_id: str, content: str):
        return await self.post_message(channel_id, finalize_ai_reply(content))

    async def create_thread(self, channel_id: str, name: str):
        return await self.json_request(
            f"/channels/{channel_id}/threads",
            method="POST",
            headers={"x-audit-log-reason": quote("Ragbot /ask conversation", safe="")},
            data={"name": name, "type": 11, "auto_archive_duration": 1440},
        )

    async def channel(self, channel_id: str):
        try:
            return await self.json_request(f"/channels/{channel_id}", optional=True)
        except Exception:
            return None

    async def messages(
        self, channel_id: str, *, before: str | None = None, limit: int = 12
    ) -> list[MessageData]:
        query = {"limit": str(limit)}
        if before:
            query["before"] = before
        result = await self.json_request(
            f"/channels/{channel_id}/messages?{urlencode(query)}", optional=True
        )
        return [m for m in result if is_message(m)] if isinstance(result, list) else []

    async def message(self, channel_id: str, message_id: str):
        result = await self.json_request(
            f"/channels/{channel_id}/messages/{message_id}", optional=True
        )
        return result if is_message(result) else None

    async def username(self, user_id: str) -> str | None:
        try:
            user = await self.json_request(f"/users/{user_id}", optional=True)
            return user.get("username") if isinstance(user, dict) else None
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
            roles = [role for role in member.get("roles", []) if isinstance(role, str)]
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
        response = await self.transport(
            f"{API_BASE}/webhooks/{application_id}/{token}{suffix}", **options
        )
        if not response.ok:
            log.warning("interaction_write_rejected status=%s", response.status)
        return response.ok
