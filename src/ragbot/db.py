"""D1 access with native Python results and parameterized statements."""

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

log = logging.getLogger("ragbot")


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def format_ban_expiry(value: str) -> str:
    try:
        return f"<t:{int(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp())}:R>"
    except ValueError:
        return value


def guild_allowed(env: Any, guild_id: str | None) -> bool:
    configured = getattr(env, "ALLOWED_GUILD_IDS", "")
    if not configured.strip():
        log.warning("allowed_guild_ids_unset")
        return True
    identifiers = (value.strip() for value in configured.split(","))
    allowed = {
        identifier
        for identifier in identifiers
        if identifier.isascii() and identifier.isdecimal() and 17 <= len(identifier) <= 20
    }
    return guild_id in allowed


@dataclass
class Database:
    binding: Any

    def statement(self, sql: str, *params: Any) -> Any:
        statement = self.binding.prepare(sql)
        return statement.bind(*params) if params else statement

    async def first(self, sql: str, *params: Any) -> dict | None:
        return await self.statement(sql, *params).first()

    async def all(self, sql: str, *params: Any) -> list[dict]:
        return (await self.statement(sql, *params).all())["results"]

    async def run(self, sql: str, *params: Any) -> Any:
        return await self.statement(sql, *params).run()

    async def batch(self, queries: list[tuple[str, tuple]]) -> list[dict]:
        statements = [self.statement(sql, *params) for sql, params in queries]
        return await self.binding.batch(statements)

    async def active_ban(self, user_id: str) -> dict | None:
        return await self.first(
            "SELECT expires_at FROM rag_command_bans WHERE banned_user_id = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1",
            user_id,
            now_iso(),
        )
