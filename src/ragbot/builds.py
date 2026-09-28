"""App builds requested from Discord. The builder service does the work; the
bot records intake in D1, runs the conversation and reports results."""

import logging
import re
import time
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from .db import Database
from .policy import suppress_mentions, suppress_url_embeds, truncate_discord
from .runtime import env_value, to_python

log = logging.getLogger("ragbot")
SNOWFLAKE = re.compile(r"[0-9]{17,20}")
TERMINAL = ("ready", "failed", "cancelled", "deleted")
FAILURES = {
    "agent_failed": "the coding agent could not finish",
    "build_failed": "the app did not build",
    "tests_failed": "the app's tests failed",
    "invalid_output": "the build output could not be published",
    "server_invalid": "its server logic could not be bundled",
    "install_failed": "its npm packages could not be installed",
    "timeout": "it ran out of time",
    "runner_lost": "the build machine kept restarting",
}


def build_guild(env: Any, guild_id: str | None) -> bool:
    """Builds need an explicitly configured guild; an unset list allows nothing."""
    configured = env_value(env, "ALLOWED_GUILD_IDS", "") or ""
    return bool(guild_id) and guild_id in {value.strip() for value in configured.split(",")}


@dataclass(frozen=True)
class BuildScope:
    guild_id: str
    channel_id: str
    user_id: str
    moderator: bool = False

    def __post_init__(self):
        if not all(
            SNOWFLAKE.fullmatch(v or "") for v in (self.guild_id, self.channel_id, self.user_id)
        ):
            raise ValueError("invalid_build_scope")

    def request(self, row: dict) -> dict:
        # The builder authorizes against the app's guild and the asking member.
        return {
            "id": row["id"],
            "guild_id": self.guild_id,
            "channel_id": row["channel_id"],
            "user_id": self.user_id,
            "moderator": self.moderator,
        }


def clean(text: str, limit: int) -> str:
    """Model-written text (titles, summaries): no mentions, raw IDs or embeds."""
    return truncate_discord(suppress_url_embeds(suppress_mentions(text or "")), limit)


def link(row: dict) -> str:
    return f"<{row['url']}>" if row.get("url") else ""


def status_text(row: dict) -> str:
    status = row.get("status") or "submitted"
    text = {
        "submitted": "is saved and waiting for the builder",
        "queued": "is queued",
        "building": "is being built",
        "publishing": "is being published",
        "ready": "is ready",
        "failed": "failed",
        "cancelled": "was cancelled",
        "deleted": "was deleted",
    }.get(status, "is in progress")
    message = f"Build `{row['id']}` {text} (revision {row.get('revision') or 1})."
    if row.get("url") and status != "deleted":
        message += f" App: {link(row)}"
    if row.get("thread_id"):
        message += f" Workspace: <#{row['thread_id']}>"
    return message


def result_text(row: dict, view: dict) -> str | None:
    """The message posted once a revision finishes."""
    status = view.get("status")
    if status == "ready":
        title = clean(view.get("title") or "", 80) or "Your app"
        summary = clean(view.get("summary") or "", 1400)
        text = f"**{title}** is ready: {link(row)}"
        return text + (f"\n\n{summary}" if summary else "")
    if status == "failed":
        reason = FAILURES.get(view.get("error") or "", "something went wrong")
        text = f"The build failed because {reason}."
        if view.get("active"):
            text += f" The previous version is still live: {link(row)}"
        return text + " Mention me here with a change to try again."
    if status == "cancelled":
        return "The build was cancelled."
    return None


@dataclass
class Builds:
    db: Database
    env: Any

    @property
    def remote(self):
        enabled = env_value(self.env, "BUILDER_ENABLED", "false") == "true"
        return env_value(self.env, "BUILDER") if enabled else None

    async def submit(self, scope: BuildScope, source_id: str, prompt: str) -> dict:
        """Record the request (idempotent per Discord message) and start it."""
        prompt = prompt.strip()
        if not 1 <= len(prompt) <= 6000 or not SNOWFLAKE.fullmatch(source_id or ""):
            raise ValueError("invalid_build_request")
        await self.db.run(
            "INSERT INTO build_requests (id, source_id, guild_id, channel_id, requester_user_id, prompt) "
            "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(source_id) DO NOTHING",
            uuid4().hex,
            source_id,
            scope.guild_id,
            scope.channel_id,
            scope.user_id,
            prompt,
        )
        row = await self.db.first(
            "SELECT * FROM build_requests WHERE source_id = ? AND guild_id = ? "
            "AND channel_id = ? AND requester_user_id = ?",
            source_id,
            scope.guild_id,
            scope.channel_id,
            scope.user_id,
        )
        if row is None:
            raise ValueError("build_source_conflict")
        return await self.refresh(row)

    async def find(self, scope: BuildScope, request_id: str) -> dict | None:
        """A request visible from this channel: its origin channel or its workspace."""
        if not re.fullmatch(r"[0-9a-f]{32}", request_id or ""):
            return None
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

    async def refresh(self, row: dict) -> dict:
        """Bring the row up to date with the builder; submission is idempotent."""
        if self.remote is None:
            return row
        scope = BuildScope(row["guild_id"], row["channel_id"], row["requester_user_id"])
        try:
            if row["status"] == "submitted":
                view = to_python(
                    await self.remote.submit({**scope.request(row), "prompt": row["prompt"]})
                )
            else:
                view = to_python(await self.remote.status(scope.request(row)))
        except Exception:
            log.warning("build_refresh_failed")
            return row
        return await self.record(row, view)

    async def record(self, row: dict, view: dict) -> dict:
        status = view.get("status") if isinstance(view.get("status"), str) else row["status"]
        revision = (
            view.get("revision") if isinstance(view.get("revision"), int) else row["revision"]
        )
        url = view.get("url") if isinstance(view.get("url"), str) else row.get("url")
        await self.db.run(
            "UPDATE build_requests SET status = ?, revision = ?, url = ?, last_polled = ? WHERE id = ?",
            status,
            revision,
            url,
            int(time.time()),
            row["id"],
        )
        return {**row, "status": status, "revision": revision, "url": url, "view": view}

    async def manage(self, scope: BuildScope, row: dict, action: str, **options) -> dict:
        """cancel, edit, rollback or delete; the builder re-checks ownership."""
        if self.remote is None:
            raise ValueError("builder_unavailable")
        if scope.user_id != row["requester_user_id"] and not scope.moderator:
            raise PermissionError("build_owner_required")
        view = to_python(await getattr(self.remote, action)({**scope.request(row), **options}))
        if action == "delete":
            await self.db.run(
                "UPDATE build_requests SET prompt = '[deleted]' WHERE id = ?", row["id"]
            )
        return await self.record(row, view)

    async def start(
        self, scope: BuildScope, source_id: str, prompt: str, requester: str, discord
    ) -> str:
        """Intake shared by `/build` and `@Ragbot build ...`; returns the reply."""
        row = await self.submit(scope, source_id, prompt)
        row = await self.ensure_thread(row, discord, requester)
        if row.get("thread_id"):
            return f"On it! Follow along in <#{row['thread_id']}>."
        if row["status"] == "submitted":
            return f"Saved build `{row['id']}`. I'll start it as soon as the builder is available."
        return f"On it! I'll post here when build `{row['id']}` is ready."

    async def change(self, scope: BuildScope, row: dict, prompt: str, source_id: str) -> str:
        """A change request for an existing app; returns the reply."""
        prompt = prompt.strip()
        if row["status"] == "deleted":
            return "This app was deleted. Start a new one with `@Ragbot build ...`."
        if not 1 <= len(prompt) <= 6000:
            return "Describe the change in 1–6000 characters."
        try:
            row = await self.manage(scope, row, "edit", prompt=prompt, operation=source_id)
        except PermissionError:
            return "Only the app's owner or Mods can change it. Describe the problem here and they can ask me."
        except Exception:
            log.warning("build_change_failed")
            return "I can't start that change right now. If a build is running, wait for it to finish and try again."
        return (
            f"Working on it (revision {row['revision']}). "
            "The current version stays live until the new one is ready."
        )

    async def ensure_thread(self, row: dict, discord, requester: str) -> dict:
        """Give a build from a text channel its own workspace thread, once."""
        if row.get("thread_id") or row.get("thread_attempted"):
            return row
        try:
            channel = await discord.channel(row["channel_id"])
            # Only plain text channels: never widen a thread or private channel.
            if not channel or channel.get("type") != 0:
                return row
            claim = await self.db.run(
                "UPDATE build_requests SET thread_attempted = 1 WHERE id = ? AND thread_attempted = 0",
                row["id"],
            )
            if not claim["meta"]["changes"]:
                return row
            name = re.sub(r"[^\w '-]+", " ", row["prompt"]).strip()[:80] or "Workspace"
            thread = await discord.create_thread(row["channel_id"], f"App · {name}")
            if not thread or not SNOWFLAKE.fullmatch(thread.get("id", "")):
                return row
            await self.db.run(
                "UPDATE build_requests SET thread_id = ? WHERE id = ?", thread["id"], row["id"]
            )
            row = {**row, "thread_id": thread["id"]}
            await discord.post_message(
                thread["id"],
                f"Building this for {requester}. I'll post the link here when it's ready, usually "
                "within a few minutes.\n\nThe owner or Mods can mention me here to change it, e.g. "
                "`@Ragbot make the buttons bigger`, or say `@Ragbot status`.",
            )
        except Exception:
            log.warning("build_thread_unavailable")
        return row

    async def reconcile(self, discord):
        """Cron: follow unfinished revisions and announce each result once."""
        if self.remote is None:
            return
        rows = await self.db.all(
            "SELECT * FROM build_requests WHERE announced_revision < revision "
            "ORDER BY last_polled LIMIT 25"
        )
        for row in rows:
            try:
                # Rotate through pending rows even when one keeps failing.
                await self.db.run(
                    "UPDATE build_requests SET last_polled = ? WHERE id = ?",
                    int(time.time()),
                    row["id"],
                )
                row = await self.refresh(row)
                view = row.get("view")
                if not view or row["status"] not in TERMINAL:
                    continue
                claim = await self.db.run(
                    "UPDATE build_requests SET announced_revision = ? "
                    "WHERE id = ? AND announced_revision < ?",
                    row["revision"],
                    row["id"],
                    row["revision"],
                )
                text = result_text(row, view)
                # Claimed first: an ambiguous POST is never repeated.
                if claim["meta"]["changes"] and text:
                    await discord.post_message(row.get("thread_id") or row["channel_id"], text)
            except Exception:
                log.warning("build_reconcile_failed")
