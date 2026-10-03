"""Rag counts and bans."""

import re
from datetime import UTC, datetime, timedelta

from ..db import format_ban_expiry, now_iso
from .registry import MODS_ROLE_ID, CommandContext, command, text_option, user_option


@command("rag", "Record a rag against a user", [user_option("User to mark as ragging")])
async def rag(ctx: CommandContext):
    invoker = ctx.invoker
    target = ctx.option("user")
    ban = await ctx.db.active_ban(invoker["id"])
    if ban:
        await ctx.reply(f"You cannot use /rag until {format_ban_expiry(ban['expires_at'])}.")
        return
    username = await ctx.target_username(target)
    results = await ctx.db.batch(
        [
            (
                "INSERT INTO rag_events (ragged_user_id, ragged_username, reported_by_user_id, reported_by_username) VALUES (?, ?, ?, ?)",
                (target, username, invoker["id"], invoker["username"]),
            ),
            (
                "INSERT INTO rag_totals (ragged_user_id, ragged_username, rag_count, updated_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP) ON CONFLICT(ragged_user_id) DO UPDATE SET rag_count = rag_count + 1, ragged_username = excluded.ragged_username, updated_at = CURRENT_TIMESTAMP RETURNING rag_count",
                (target, username),
            ),
        ]
    )
    count = results[1]["results"][0]["rag_count"]
    await ctx.reply(f"<@{target}> just ragged. Total: {count}", users=[target])


@command("ragboard", "Show the rag leaderboard")
async def ragboard(ctx: CommandContext):
    rows = await ctx.db.all(
        "SELECT ragged_user_id, ragged_username, rag_count FROM rag_totals ORDER BY rag_count DESC, ragged_user_id ASC LIMIT 10"
    )
    if not rows:
        await ctx.reply("No rags have been recorded yet.")
        return
    lines = []
    for index, row in enumerate(rows, 1):
        mention = f"<@{row['ragged_user_id']}>"
        name = f"{row['ragged_username']} ({mention})" if row["ragged_username"] else mention
        lines.append(f"{index}. {name} - {row['rag_count']}")
    await ctx.reply("Ragboard\n" + "\n".join(lines))


@command(
    "undorag",
    "Undo the last rag recorded against a user",
    [user_option("User whose last rag should be undone")],
    required_role_id=MODS_ROLE_ID,
)
async def undorag(ctx: CommandContext):
    target = ctx.option("user")
    latest = await ctx.db.first(
        "SELECT id FROM rag_events WHERE ragged_user_id = ? ORDER BY id DESC LIMIT 1", target
    )
    if not latest:
        await ctx.reply(f"<@{target}> has no rags to undo.", users=[target])
        return
    results = await ctx.db.batch(
        [
            ("DELETE FROM rag_events WHERE id = ?", (latest["id"],)),
            (
                "UPDATE rag_totals SET rag_count = max(rag_count - 1, 0), updated_at = CURRENT_TIMESTAMP WHERE ragged_user_id = ? RETURNING rag_count",
                (target,),
            ),
        ]
    )
    count = results[1]["results"][0]["rag_count"] if results[1]["results"] else 0
    await ctx.reply(f"Undid the last rag for <@{target}>. Total: {count}", users=[target])


@command(
    "raghammer",
    "Temporarily block a user from using /rag",
    [
        user_option("User to block from /rag"),
        text_option("timeframe", "Examples: 5m, 1h, 1d. Use only m, h, or d.", 12, minimum=2),
    ],
    required_role_id=MODS_ROLE_ID,
)
async def raghammer(ctx: CommandContext):
    invoker = ctx.invoker
    target = ctx.option("user")
    match = re.fullmatch(r"([1-9][0-9]*)([mhd])", ctx.option("timeframe").lower())
    if not match or len(match[1]) > 16 or int(match[1]) > 2**53 - 1:
        await ctx.reply("Timeframe must use minutes, hours, or days, like 5m, 1h, or 1d.")
        return
    seconds = int(match[1]) * {"m": 60, "h": 3600, "d": 86400}[match[2]]
    if seconds > 365 * 86400:
        await ctx.reply("Timeframe must be 365d or less.")
        return
    expires = (
        (datetime.now(UTC) + timedelta(seconds=seconds))
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )
    username = await ctx.target_username(target)
    await ctx.db.run(
        "INSERT INTO rag_command_bans (banned_user_id, banned_username, banned_by_user_id, banned_by_username, expires_at) VALUES (?, ?, ?, ?, ?)",
        target,
        username,
        invoker["id"],
        invoker["username"],
        expires,
    )
    await ctx.reply(f"<@{target}> cannot use /rag for {int(match[1])}{match[2]}.", users=[target])


@command(
    "ragunban",
    "Remove a user's current /rag ban",
    [user_option("User to allow back onto /rag")],
    admin_only=True,
)
async def ragunban(ctx: CommandContext):
    target = ctx.option("user")
    result = await ctx.db.run(
        "DELETE FROM rag_command_bans WHERE banned_user_id = ? AND expires_at > ?",
        target,
        now_iso(),
    )
    text = (
        f"<@{target}> can use /rag again."
        if result.get("meta", {}).get("changes", 0)
        else f"<@{target}> does not have an active /rag ban."
    )
    await ctx.reply(text, users=[target])
