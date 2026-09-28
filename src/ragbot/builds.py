"""Durable coding request intake; no agent or deployment credentials are needed."""

import logging
import re
import time
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from .config import ConfigStore
from .db import Database
from .runtime import env_value, to_python


@dataclass(frozen=True)
class BuildScope:
    guild_id: str
    channel_id: str
    user_id: str

    def __post_init__(self):
        if not all(
            re.fullmatch(r"[0-9]{17,20}", v) for v in (self.guild_id, self.channel_id, self.user_id)
        ):
            raise ValueError("invalid_build_scope")


@dataclass
class BuildRequests:
    db: Database
    env: Any = None
    config: ConfigStore | None = None

    @property
    def remote(self):
        return (
            env_value(self.env, "BUILDER")
            if env_value(self.env, "BUILDER_ENABLED", "false") == "true"
            else None
        )

    async def submit(self, scope: BuildScope, source_id: str, kind: str, prompt: str) -> dict:
        prompt = prompt.strip()
        if kind not in ("site", "feature") or not 1 <= len(prompt) <= 6000:
            raise ValueError("invalid_build_request")
        if not re.fullmatch(r"[0-9]{17,20}", source_id):
            raise ValueError("invalid_build_source")
        await self.db.run(
            "INSERT INTO build_requests "
            "(id, source_id, guild_id, channel_id, requester_user_id, kind, prompt) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id) DO NOTHING",
            uuid4().hex,
            source_id,
            scope.guild_id,
            scope.channel_id,
            scope.user_id,
            kind,
            prompt,
        )
        row = await self.db.first(
            "SELECT * FROM build_requests WHERE source_id = ? "
            "AND guild_id = ? AND channel_id = ? AND requester_user_id = ?",
            source_id,
            scope.guild_id,
            scope.channel_id,
            scope.user_id,
        )
        if row is None:
            raise ValueError("build_source_conflict")
        return row

    async def status(self, scope: BuildScope, request_id: str) -> dict | None:
        if not re.fullmatch(r"[0-9a-f]{32}", request_id):
            return None
        # Scope to the originating channel as well as guild to avoid private-channel leaks.
        return await self.db.first(
            "SELECT * FROM build_requests WHERE id = ? AND guild_id = ? AND (channel_id = ? OR thread_id = ?)",
            request_id,
            scope.guild_id,
            scope.channel_id,
            scope.channel_id,
        )

    async def in_thread(self, scope: BuildScope) -> dict | None:
        return await self.db.first(
            "SELECT * FROM build_requests WHERE guild_id = ? AND thread_id = ?",
            scope.guild_id,
            scope.channel_id,
        )

    async def ensure_thread(self, row: dict, discord) -> dict:
        if row.get("thread_id") or row.get("thread_attempted"):
            return row
        try:
            channel = await discord.channel(row["channel_id"])
            # Never create a broader sibling channel for a private-thread request.
            if not channel or channel.get("type") != 0:
                return row
            claim = await self.db.run(
                "UPDATE build_requests SET thread_attempted = 1 WHERE id = ? AND thread_attempted = 0",
                row["id"],
            )
            if not claim["meta"]["changes"]:
                return row
            # Claim before POST: ambiguous failures must not create duplicate threads.
            thread = await discord.create_thread(
                row["channel_id"],
                "App · " + (re.sub(r"[^\w -]", "", row["prompt"])[:70].strip() or "Workspace"),
            )
            if not thread or not re.fullmatch(r"[0-9]{17,20}", thread.get("id", "")):
                return row
            await self.db.run(
                "UPDATE build_requests SET thread_id = ?, notice_id = NULL, notice_attempted = 0 WHERE id = ?",
                thread["id"],
                row["id"],
            )
            row = {**row, "thread_id": thread["id"], "notice_id": None, "notice_attempted": 0}
            await discord.post_message(
                thread["id"],
                "This is your app workspace. The owner or Mods can mention Ragbot with a change "
                "or bug report, e.g. `@ragbot add a leaderboard`. Use `/buildstatus` here "
                "without a request ID. Ordinary discussion will not start a build. "
                "Use `/buildpass` for a private login code.\n" + build_status_text(row),
            )
        except Exception:
            logging.getLogger("ragbot").warning("build_thread_unavailable")
        return row

    def payload(self, row: dict) -> dict:
        return {
            "id": row["id"],
            "source_id": row["source_id"],
            "kind": row["kind"],
            "prompt": row["prompt"],
            "guild_id": row["guild_id"],
            "channel_id": row["channel_id"],
            "user_id": row["requester_user_id"],
        }

    async def coding_config(self, kind: str) -> dict:
        store = self.config or ConfigStore(self.env)
        snapshot = await store.snapshot()
        document = store.document_from(snapshot, "coding-agent.json")
        return {
            "model": document["model"],
            "instructions": document[
                "siteInstructions" if kind == "site" else "featureInstructions"
            ],
            "config_revision": snapshot["revision"],
        }

    async def sync(self, row: dict) -> dict:
        if self.remote is None:
            return row
        # Submission is idempotent by request ID at the service boundary.
        result = to_python(
            await self.remote.submit({**self.payload(row), **await self.coding_config(row["kind"])})
        )
        await self.db.run(
            "UPDATE build_requests SET remote_status = ?, result_url = ?, revision = ?, "
            "last_polled = ? WHERE id = ?",
            result["status"],
            result.get("url"),
            result.get("revision", 1),
            int(time.time()),
            row["id"],
        )
        return {
            **row,
            "remote_status": result["status"],
            "result_url": result.get("url"),
            "revision": result.get("revision", 1),
        }

    async def manage(
        self, scope: BuildScope, request_id: str, action: str, *, moderator: bool = False, **options
    ) -> dict:
        row = await self.status(scope, request_id)
        if row is None or self.remote is None:
            raise ValueError("builder_unavailable")
        payload = {
            "id": request_id,
            "guild_id": scope.guild_id,
            "channel_id": row["channel_id"],
            "user_id": scope.user_id,
            "moderator": moderator,
            **options,
        }
        if action == "passcode":
            return to_python(await self.remote.passcode(payload))
        if scope.user_id != row["requester_user_id"] and not moderator:
            raise ValueError("build_owner_required")
        if action == "edit":
            payload.update(await self.coding_config(row["kind"]))
        result = to_python(await self.remote.action({**payload, "action": action}))
        await self.db.run(
            "UPDATE build_requests SET remote_status = ?, result_url = ?, revision = ?, "
            "last_polled = 0 WHERE id = ?",
            result["status"],
            result.get("url"),
            result.get("revision", 1),
            request_id,
        )
        if action == "delete":
            await self.db.run(
                "UPDATE build_requests SET prompt = '[deleted]' WHERE id = ?", request_id
            )
        return result

    async def reconcile(self, discord):
        await self.db.run(
            "UPDATE build_requests SET prompt = '[expired]' WHERE created_at < datetime('now', '-30 days') AND prompt NOT IN ('[expired]', '[deleted]')"
        )
        if self.remote is None:
            return
        rows = await self.db.all(
            "SELECT * FROM build_requests WHERE remote_status IS NULL OR "
            "remote_status NOT IN ('ready', 'pr_ready', 'failed', 'cancelled', 'deleted') "
            "ORDER BY last_polled LIMIT 25"
        )
        for row in rows:
            try:
                await self.db.run(
                    "UPDATE build_requests SET last_polled = ? WHERE id = ?",
                    int(time.time()),
                    row["id"],
                )
                row = await self.ensure_thread(row, discord)
                current = await self.sync(row)
                channel_id = row.get("thread_id") or row["channel_id"]
                text = build_status_text(current)
                if row.get("notice_id"):
                    await discord.request(
                        f"/channels/{channel_id}/messages/{row['notice_id']}",
                        method="PATCH",
                        data={"content": text, "allowed_mentions": {"parse": []}},
                    )
                elif not row["notice_attempted"]:
                    # Claim once before the ambiguous Discord POST; never replay a lost response.
                    claim = await self.db.run(
                        "UPDATE build_requests SET notice_attempted = 1 WHERE id = ? AND notice_attempted = 0",
                        row["id"],
                    )
                    if claim["meta"]["changes"]:
                        response = await discord.post_message(channel_id, text)
                        if response.ok:
                            notice = await response.json()
                            if re.fullmatch(r"[0-9]{17,20}", notice.get("id", "")):
                                await self.db.run(
                                    "UPDATE build_requests SET notice_id = ? WHERE id = ?",
                                    notice["id"],
                                    row["id"],
                                )
            except Exception:
                logging.getLogger("ragbot").warning("build_reconcile_failed")


def build_status_text(row: dict) -> str:
    state = row.get("remote_status") or row.get("status", "submitted")
    message = f"Build `{row['id']}`: {state} (revision {row.get('revision', 1)})."
    if row.get("result_url"):
        message += f" <{row['result_url']}>"
    if not row.get("remote_status"):
        message += " Saved; waiting for the builder connection."
    if row.get("thread_id"):
        message += (
            f" Workspace: <https://discord.com/channels/{row['guild_id']}/{row['thread_id']}>"
        )
    else:
        message += " Use `/buildedit` with this request ID if a workspace thread is unavailable."
    return message
