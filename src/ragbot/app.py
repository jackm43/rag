"""Application composition and ingress workflows; no global event loop."""

import logging
import re
import time

from .ai import Attribution, Inference
from .commands import COMMANDS, CommandContext
from .commands.registry import ADMIN_IDS
from .config import ConfigStore
from .conversation import ChatJob, display_name, process_chat, strip_mentions
from .db import Database, format_ban_expiry, guild_allowed
from .discord import DiscordClient, Transport, is_message
from .env import Env
from .policy import truncate_discord
from .runtime import fetch

log = logging.getLogger("ragbot")


class Application:
    def __init__(self, env: Env, *, transport: Transport = fetch):
        self.env, self.transport = env, transport
        self.db = Database(env.DB)
        self.discord = DiscordClient(env.DISCORD_BOT_TOKEN, transport)
        self.config = ConfigStore(env)
        self.ai = Inference(env, self.db, self.config, transport)

    async def dispatch(self, interaction: dict):
        if not interaction.get("application_id") or not interaction.get("token"):
            log.error("dispatch_missing_interaction_credentials")
            return
        ctx = CommandContext(interaction, self)
        try:
            if interaction.get("type") != 2:
                return
            if not guild_allowed(self.env, interaction.get("guild_id")):
                await ctx.reply("This bot only works in its home server.")
                return
            name = interaction.get("data", {}).get("name")
            command = COMMANDS.get(name)
            if not command:
                await ctx.reply("Unknown command.")
                return
            invoker_id = ctx.invoker.get("id")
            if command.admin_only and invoker_id not in ADMIN_IDS:
                await ctx.reply(f"You are not allowed to use /{name}.")
                return
            if command.ai_limited:
                if invoker_id:
                    ban = await self.db.active_ban(invoker_id, fail_open=True)
                    if ban:
                        await ctx.reply(
                            f"You cannot use AI commands until {format_ban_expiry(ban['expires_at'])}."
                        )
                        return
                denial = await self.db.usage_denial(self.env, invoker_id, name)
                if denial:
                    await ctx.reply(denial)
                    return
            await command.execute(ctx)
        except Exception:
            log.error("command_execute_failed")
            try:
                await ctx.reply("Command failed. Try again.")
            except Exception:
                log.warning("command_failure_notice_failed")

    async def handle_message(self, message: dict, bot_user_id: str | None):
        if not is_message(message) or (message.get("author") or {}).get("bot") or not bot_user_id:
            return
        guild_id = message.get("guild_id")
        if not guild_allowed(self.env, guild_id) or not strip_mentions(message.get("content", "")):
            return
        started_at = time.monotonic()
        try:
            content = truncate_discord(message.get("content", ""), 4000)
            thread = await self.db.find_thread(message["channel_id"]) if guild_id else None
            if not thread:

                def snowflakes(values):
                    return list(
                        dict.fromkeys(
                            v
                            for v in values
                            if isinstance(v, str) and re.fullmatch(r"[0-9]{17,20}", v)
                        )
                    )[:100]

                users = set(
                    snowflakes(
                        m.get("id") for m in message.get("mentions", []) if isinstance(m, dict)
                    )
                )
                role_ids = snowflakes(message.get("mention_roles", []))
                bot_roles = (
                    await self.discord.bot_roles(guild_id, bot_user_id)
                    if role_ids and guild_id
                    else []
                )
                roles = set(role_ids)
                for marker, identifier in re.findall(r"<@([!&]?)([^>\s]+)>", content):
                    (roles if marker == "&" else users).add(identifier)
                if (
                    bot_user_id not in users
                    and self.env.DISCORD_APPLICATION_ID not in users
                    and not roles.intersection(bot_roles)
                ):
                    return
            prompt = strip_mentions(content)
            if not prompt:
                return
            user_id = (message.get("author") or {}).get("id")
            if user_id and await self.db.active_ban(user_id, fail_open=True):
                return
            kind = "thread_reply" if thread else "channel_reply"
            denial = await self.db.usage_denial(self.env, user_id, kind)
            if denial:
                await self.discord.reply(message["channel_id"], denial)
                return
            reference = message.get("message_reference") or {}
            referenced = message.get("referenced_message") or {}
            job = ChatJob(
                Attribution(
                    kind, user_id, display_name(message), message["channel_id"], message["id"]
                ),
                prompt,
                bot_user_id,
                thread,
                reference.get("message_id") or referenced.get("id"),
                reference.get("channel_id") or referenced.get("channel_id"),
            )
        except Exception:
            log.error("gateway_message_resolve_failed")
            return
        await process_chat(self, job, started_at)
