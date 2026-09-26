"""D1 access with native Python results and parameterized statements."""

import logging
import math
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from .runtime import env_value, to_python

log = logging.getLogger("ragbot")


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def format_ban_expiry(value: str) -> str:
    try:
        return f"<t:{int(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp())}:R>"
    except ValueError:
        return value


def guild_allowed(env: Any, guild_id: str | None) -> bool:
    configured = env_value(env, "ALLOWED_GUILD_IDS", "")
    if not configured.strip():
        log.warning("allowed_guild_ids_unset")
        return True
    allowed = {v.strip() for v in configured.split(",") if re.fullmatch(r"[0-9]{17,20}", v.strip())}
    return guild_id in allowed


@dataclass
class Database:
    binding: Any

    def statement(self, sql: str, *params: Any) -> Any:
        statement = self.binding.prepare(sql)
        return statement.bind(*params) if params else statement

    async def first(self, sql: str, *params: Any) -> dict | None:
        return to_python(await self.statement(sql, *params).first())

    async def all(self, sql: str, *params: Any) -> list[dict]:
        return to_python(await self.statement(sql, *params).all())["results"]

    async def run(self, sql: str, *params: Any) -> Any:
        return to_python(await self.statement(sql, *params).run())

    async def batch(self, queries: list[tuple[str, tuple]]) -> list[dict]:
        statements = [self.statement(sql, *params) for sql, params in queries]
        return to_python(await self.binding.batch(statements))

    async def active_ban(self, user_id: str, *, fail_open: bool = False) -> dict | None:
        try:
            return await self.first(
                "SELECT expires_at FROM rag_command_bans WHERE banned_user_id = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1",
                user_id,
                now_iso(),
            )
        except Exception:
            if not fail_open:
                raise
            log.warning("ai_ban_check_failed")
            return None

    async def find_thread(self, thread_id: str) -> dict | None:
        try:
            return await self.first(
                "SELECT thread_id, parent_channel_id, source_message_id, requester_user_id, requester_username, initial_prompt, title FROM rag_ai_threads WHERE thread_id = ?",
                thread_id,
            )
        except Exception:
            log.warning("ai_thread_lookup_failed")
            return None

    async def record_thread(self, thread: dict) -> None:
        fields = (
            "thread_id",
            "parent_channel_id",
            "source_message_id",
            "requester_user_id",
            "requester_username",
            "initial_prompt",
            "title",
        )
        await self.run(
            "INSERT INTO rag_ai_threads (thread_id, parent_channel_id, source_message_id, requester_user_id, requester_username, initial_prompt, title, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(thread_id) DO UPDATE SET parent_channel_id = excluded.parent_channel_id, source_message_id = excluded.source_message_id, requester_user_id = excluded.requester_user_id, requester_username = excluded.requester_username, initial_prompt = excluded.initial_prompt, title = excluded.title, updated_at = CURRENT_TIMESTAMP",
            *(thread.get(field) for field in fields),
        )

    async def usage_denial(self, env: Any, user_id: str | None, kind: str) -> str | None:
        if not user_id:
            return None

        def positive(name: str, fallback: float) -> float:
            try:
                value = float(env_value(env, name, fallback))
                return value if math.isfinite(value) and value > 0 else fallback
            except ValueError, TypeError:
                return fallback

        burst = int(positive("AI_BURST_LIMIT_PER_MINUTE", 8))
        budget = round(positive("AI_GLOBAL_DAILY_BUDGET_USD", 10) * 1_000_000)
        try:
            results = await self.batch(
                [
                    (
                        "SELECT COUNT(*) AS request_count FROM rag_ai_requests WHERE requester_user_id = ? AND created_at >= datetime('now', '-1 minute')",
                        (user_id,),
                    ),
                    (
                        "SELECT COALESCE(SUM(estimated_cost_micros), 0) AS spend_micros FROM rag_ai_spend_events WHERE created_at >= datetime('now', '-24 hours')",
                        (),
                    ),
                ]
            )
            if results[0]["results"][0]["request_count"] >= burst:
                return "Slow down a little — try again in a minute."
            if results[1]["results"][0]["spend_micros"] >= budget:
                return "The server's daily AI budget is spent. Try again tomorrow."
            await self.run(
                "INSERT INTO rag_ai_requests (requester_user_id, kind) VALUES (?, ?)", user_id, kind
            )
        except Exception:
            log.warning("ai_usage_check_failed")
        return None

    async def prune_requests(self) -> None:
        try:
            await self.run(
                "DELETE FROM rag_ai_requests WHERE created_at < datetime('now', '-1 day')"
            )
        except Exception:
            log.warning("ai_request_log_prune_failed")
