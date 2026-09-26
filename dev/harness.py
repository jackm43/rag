"""Local simulations with per-run dependency injection and no Discord egress."""

import base64
import contextvars
import json
import logging
import secrets
import time
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

from ragbot._bundled import FILES
from ragbot.app import Application
from ragbot.config import ConfigStore
from ragbot.db import Database
from ragbot.runtime import fetch, to_python

captured_logs = contextvars.ContextVar("captured_logs", default=None)


class CaptureLogs(logging.Handler):
    def emit(self, record):
        target = captured_logs.get()
        if target is not None:
            target.append({"level": record.levelname.lower(), "message": record.getMessage()})


logging.getLogger("ragbot").addHandler(CaptureLogs())


def snowflake():
    return str(((int(time.time() * 1000) - 1420070400000) << 22) | secrets.randbelow(4096))


def author(identity):
    return {
        "id": identity["userId"],
        "username": identity["username"],
        "global_name": identity.get("globalName"),
    }


def display_name(identity):
    return next(
        (
            identity[k].strip()
            for k in ("nick", "globalName", "username")
            if isinstance(identity.get(k), str) and identity[k].strip()
        ),
        "user",
    )


class ConfigNamespace:
    def __init__(self, overrides):
        self.values = dict(overrides.get("kv") or {})
        for key, fields in [
            (
                "discord-response.json",
                {k: k for k in ("model", "temperature", "maxTokens", "historyLimit")},
            ),
            ("ask-web-search.json", {"model": "webSearchModel"}),
        ]:
            try:
                document = json.loads(self.values.get(key, FILES[key]))
                if not isinstance(document, dict):
                    document = {}
            except ValueError, TypeError:
                document = {}
            for field, source in fields.items():
                value = overrides.get(source)
                if value is not None and value != "":
                    document[field] = value
            self.values[key] = json.dumps(document)

    async def get(self, key):
        return self.values.get(key)


async def resolve_config(overrides):
    chat, search = await ConfigStore(SimpleNamespace(AI_CONFIG=ConfigNamespace(overrides))).models()
    return {
        "responseModel": chat.model,
        "systemPrompt": chat.prompt,
        "maxTokens": chat.max_tokens,
        "temperature": chat.temperature,
        "historyLimit": chat.history_limit,
        "gatewayId": chat.gateway_id,
        "askWebSearchModel": search.model,
        "askWebSearchSystemPrompt": search.prompt,
        "askWebSearchMaxOutputTokens": search.max_tokens,
        "askWebSearchTemperature": search.temperature,
        "askWebSearchMaxTurns": search.max_turns,
        "askWebSearchContextSize": search.search_context_size,
        "askWebSearchGatewayId": search.gateway_id,
    }


def dev_metadata(metadata):
    tagged = {"ragbot_env": "dev", **metadata}
    for key in ("discord_message_id", "discord_channel_id"):
        if len(tagged) > 5:
            tagged.pop(key, None)
    return tagged


def safe_headers(headers):
    return {
        k: "[redacted]"
        if any(word in k.lower() for word in ("authorization", "token", "cookie", "key"))
        else v
        for k, v in headers.items()
    }


class Response:
    def __init__(self, body, status=200):
        self.body, self.status, self.ok = body, status, 200 <= status < 300

    async def json(self):
        return self.body


class BindingTap:
    def __init__(self, binding, exchanges):
        self.binding, self.exchanges = binding, exchanges

    async def run(self, model, inputs, options=None):
        started = time.monotonic()
        inputs, options = to_python(inputs), to_python(options)
        if options and options.get("gateway"):
            options["gateway"]["metadata"] = dev_metadata(options["gateway"].get("metadata", {}))
        exchange = {
            "transport": "workers-ai-binding",
            "model": model,
            "request": {"binding": "AI", "model": model, "input": inputs, "options": options},
            "response": None,
            "durationMs": 0,
        }
        self.exchanges.append(exchange)
        try:
            args = [model, inputs]
            if options:
                args.append(options)
            result = to_python(await self.binding.run(*args))
            exchange["response"] = (
                {"stream": True}
                if hasattr(result, "getReader")
                else {"binary": True, "bytes": len(result)}
                if isinstance(result, (bytes, bytearray, memoryview))
                else result
            )
            return result
        except Exception as exc:
            exchange["error"] = type(exc).__name__
            raise
        finally:
            exchange["durationMs"] = round((time.monotonic() - started) * 1000)


class Simulation:
    def __init__(self, env, inputs, upstream=fetch):
        self.env, self.inputs, self.upstream = env, inputs, upstream
        self.calls, self.ai, self.logs = [], [], []
        self.edits, self.followups, self.messages, self.threads = [], [], [], []
        self.history = []
        self.run_env = SimpleNamespace(
            **{
                key: getattr(env, key, None)
                for key in (
                    "DB",
                    "DISCORD_APPLICATION_ID",
                    "DISCORD_BOT_TOKEN",
                    "ALLOWED_GUILD_IDS",
                    "CF_ACCOUNT_ID",
                    "CF_AIG_TOKEN",
                    "AI_BURST_LIMIT_PER_MINUTE",
                    "AI_GLOBAL_DAILY_BUDGET_USD",
                )
            }
        )
        self.run_env.AI_CONFIG = ConfigNamespace(inputs.get("overrides") or {})
        self.run_env.AI = BindingTap(getattr(env, "AI", None), self.ai)
        self.app = Application(self.run_env, transport=self.transport)

    def transcript_message(self, entry):
        identity = entry.get("author") or self.inputs["identity"]
        return {
            "id": entry["id"],
            "channel_id": self.inputs["channelId"],
            "guild_id": self.inputs["guildId"],
            "content": entry["content"],
            "author": {"id": self.inputs["botUserId"], "username": "ragbot", "bot": True}
            if entry["role"] == "bot"
            else author(identity),
            "member": {"nick": identity.get("nick")},
        }

    async def capture_write(self, options, channel_id):
        body = options.get("body")
        attachments = []
        if isinstance(body, str):
            data = json.loads(body)
        else:
            data = json.loads(body.get("payload_json"))
            for index, info in enumerate(data.get("attachments", [])):
                file = body.get(f"files[{index}]")
                attachment = {
                    "name": info["filename"],
                    "contentType": file.type,
                    "bytes": file.size,
                }
                if file.size <= 8 * 1024 * 1024:
                    from js import Uint8Array

                    raw = bytes(Uint8Array.new(await file.arrayBuffer()).to_py())
                    attachment["dataUrl"] = (
                        f"data:{file.type};base64,{base64.b64encode(raw).decode()}"
                    )
                attachments.append(attachment)
        return {
            "id": snowflake(),
            "channelId": channel_id,
            "content": data.get("content", ""),
            "allowedMentions": data.get("allowed_mentions"),
            "attachments": attachments,
        }

    async def transport(self, url, **options):
        started = time.monotonic()
        parsed = urlparse(url)
        method = options.get("method", "GET")
        if parsed.hostname == "gateway.ai.cloudflare.com":
            headers = dict(options.get("headers", {}))
            headers["cf-aig-metadata"] = json.dumps(
                dev_metadata(json.loads(headers.get("cf-aig-metadata", "{}")))
            )
            options["headers"] = headers
        safe_url = url
        if parsed.hostname == "discord.com" and "/webhooks/" in parsed.path:
            parts = parsed.path.split("/")
            parts[5] = "[redacted]"
            safe_url = parsed._replace(path="/".join(parts)).geturl()
        try:
            body = (
                json.loads(options["body"])
                if isinstance(options.get("body"), str)
                else {"multipart": True}
                if options.get("body") is not None
                else None
            )
        except ValueError:
            body = "[unparsed]"
        call = {
            "method": method,
            "url": safe_url,
            "headers": safe_headers(options.get("headers", {})),
            "body": body,
            "durationMs": 0,
        }
        self.calls.append(call)
        if parsed.hostname == "discord.com":
            response = await self.discord_stub(parsed, method, options)
            call["response"] = {"status": response.status, "body": await response.json()}
            call["stubbed"] = True
        else:
            # Only the Discord API is stubbed; model/media calls use the injected upstream.
            response = await self.upstream(url, **options)
            if parsed.hostname == "gateway.ai.cloudflare.com":
                payload = await response.json()
                call["response"] = {"status": response.status, "body": payload}
                self.ai.append(
                    {
                        "transport": "gateway-http",
                        "model": (body or {}).get("model", "unknown"),
                        "request": {k: call[k] for k in ("method", "url", "headers", "body")},
                        "response": call["response"],
                        "durationMs": round((time.monotonic() - started) * 1000),
                        **({"error": f"HTTP {response.status}"} if not response.ok else {}),
                    }
                )
                response = Response(payload, response.status)
        call["durationMs"] = round((time.monotonic() - started) * 1000)
        return response

    async def discord_stub(self, url, method, options):
        parts = url.path.removeprefix("/api/v10/").split("/")
        channel_id = self.inputs["channelId"]
        if parts[0] == "channels":
            channel_id = parts[1]
            if method == "POST" and parts[-1] == "threads":
                data = json.loads(options["body"])
                thread = {"id": snowflake(), "name": data["name"], "parentId": channel_id}
                self.threads.append(thread)
                return Response(
                    {
                        "id": thread["id"],
                        "name": thread["name"],
                        "parent_id": channel_id,
                        "type": 11,
                    }
                )
            if method == "POST" and parts[-1] == "messages":
                message = await self.capture_write(options, channel_id)
                self.messages.append(message)
                return Response({"id": message["id"]})
            if method == "GET" and len(parts) == 2:
                return Response(
                    {
                        "id": channel_id,
                        "type": 11 if self.inputs.get("mode") in ("thread", "ask_thread") else 0,
                        "parent_id": self.inputs["guildId"],
                    }
                )
            if method == "GET" and len(parts) == 3 and parts[-1] == "messages":
                query = parse_qs(url.query)
                before = query.get("before", [None])[0]
                history = [m for m in self.history if not before or int(m["id"]) < int(before)]
                return Response(list(reversed(history))[: int(query.get("limit", [12])[0])])
            if method == "GET" and len(parts) == 4:
                return Response(next((m for m in self.history if m["id"] == parts[-1]), None), 200)
        if parts[0] == "webhooks" and method in ("PATCH", "POST"):
            (self.edits if method == "PATCH" else self.followups).append(
                await self.capture_write(options, channel_id)
            )
            return Response({"id": snowflake()})
        if parts[0] == "users":
            identity = self.inputs.get("resolvedUsers", {}).get(parts[1])
            return Response(
                author(identity)
                if identity
                else {"id": parts[1], "username": "user_" + parts[1][-4:]}
            )
        if parts[0] == "guilds":
            return Response({"roles": []})
        return Response({})

    async def run(self, mode):
        started = time.monotonic()
        db = Database(self.env.DB)
        watermark = await db.first("SELECT COALESCE(MAX(id), 0) AS max_id FROM rag_ai_spend_events")
        log_token = captured_logs.set(self.logs)
        try:
            identity = self.inputs["identity"]
            if mode == "mention":
                transcript = self.inputs.get("transcript", [])
                is_thread = self.inputs.get("mode", "channel") != "channel"
                first = transcript[0] if transcript else None
                if is_thread:
                    initial = (
                        first["content"]
                        if first and first["role"] == "user"
                        else self.inputs["content"]
                    )
                    await db.record_thread(
                        {
                            "thread_id": self.inputs["channelId"],
                            "parent_channel_id": self.inputs["guildId"],
                            "source_message_id": (first["id"] if first else snowflake())
                            if self.inputs["mode"] == "thread"
                            else None,
                            "requester_user_id": (
                                first.get("author", identity) if first else identity
                            )["userId"],
                            "requester_username": display_name(
                                first.get("author", identity) if first else identity
                            ),
                            "initial_prompt": initial,
                            "title": initial[:80],
                        }
                    )
                else:
                    await db.run(
                        "DELETE FROM rag_ai_threads WHERE thread_id = ?", self.inputs["channelId"]
                    )
                history = (
                    transcript[1:]
                    if is_thread and first and first["role"] == "user"
                    else transcript
                )
                self.history = [self.transcript_message(entry) for entry in history]
                mention = self.inputs.get("mentionBot", True)
                payload = {
                    "id": snowflake(),
                    "guild_id": self.inputs["guildId"],
                    "channel_id": self.inputs["channelId"],
                    "content": f"<@{self.inputs['botUserId']}> {self.inputs['content']}"
                    if mention
                    else self.inputs["content"],
                    "author": author(identity),
                    "member": {"nick": identity.get("nick")},
                    "mentions": [{"id": self.inputs["botUserId"], "username": "ragbot"}]
                    if mention
                    else [],
                    "mention_roles": [],
                    "attachments": [],
                }
                reply = next(
                    (entry for entry in transcript if entry["id"] == self.inputs.get("replyToId")),
                    None,
                )
                if reply:
                    payload["message_reference"] = {
                        "channel_id": self.inputs["channelId"],
                        "message_id": reply["id"],
                    }
                    payload["referenced_message"] = self.transcript_message(reply)
                    if not any(m["id"] == reply["id"] for m in self.history):
                        self.history.insert(0, self.transcript_message(reply))
                await self.app.handle_message(payload, self.inputs["botUserId"])
                extra = {"message": payload, "replies": self.messages}
                analytics = await db.first(
                    "SELECT * FROM rag_ai_interactions WHERE message_id = ? ORDER BY id DESC LIMIT 1",
                    payload["id"],
                )
            else:
                options = self.inputs.get("options", [])
                resolved = {
                    o["value"]: author(
                        self.inputs.get("resolvedUsers", {}).get(
                            o["value"],
                            {"userId": o["value"], "username": "user_" + o["value"][-4:]},
                        )
                    )
                    for o in options
                    if o.get("type") == 6 and o.get("value")
                }
                payload = {
                    "id": snowflake(),
                    "type": 2,
                    "version": 1,
                    "application_id": self.env.DISCORD_APPLICATION_ID,
                    "token": "dev-interaction-" + snowflake(),
                    "guild_id": self.inputs["guildId"],
                    "channel_id": self.inputs["channelId"],
                    "member": {"user": author(identity), "nick": identity.get("nick"), "roles": []},
                    "data": {
                        "id": snowflake(),
                        "type": 1,
                        "name": self.inputs["command"],
                        "options": options,
                        "resolved": {"users": resolved},
                    },
                }
                await self.app.dispatch(payload)
                extra = {
                    "interaction": payload,
                    "edits": self.edits,
                    "followUps": self.followups,
                    "channelMessages": self.messages,
                    "threadsCreated": self.threads,
                }
                analytics = await db.first(
                    "SELECT * FROM rag_ai_interactions ORDER BY id DESC LIMIT 1"
                )
            return {
                **extra,
                "durationMs": round((time.monotonic() - started) * 1000),
                "ai": self.ai,
                "calls": self.calls,
                "logs": self.logs,
                "db": {
                    "interaction": analytics,
                    "spendEvents": await db.all(
                        "SELECT * FROM rag_ai_spend_events WHERE id > ? ORDER BY id ASC",
                        watermark["max_id"],
                    ),
                },
            }
        finally:
            captured_logs.reset(log_token)
