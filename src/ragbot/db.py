"""D1 access with native Python results and parameterized statements."""

import logging
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

    async def active_ban(self, user_id: str) -> dict | None:
        return await self.first(
            "SELECT expires_at FROM rag_command_bans WHERE banned_user_id = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1",
            user_id,
            now_iso(),
        )
