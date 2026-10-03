"""Application composition and ingress workflows; no global event loop."""

import logging
import re
import time

from .ai import Attribution, Inference
from .commands import COMMANDS, CommandContext
from .commands.registry import ADMIN_IDS
from .config import ConfigStore
from .conversation import ChatJob, display_name, message_text, process_chat, strip_mentions
from .db import Database, guild_allowed
from .discord import DiscordClient, Transport
from .env import Env
from .policy import truncate_discord
from .runtime import fetch

log = logging.getLogger("ragbot")


class Application:
    def __init__(
        self, env: Env, *, transport: Transport = fetch, config: ConfigStore | None = None
    ):
        self.env, self.transport = env, transport
        self.db = Database(env.DB)
        self.discord = DiscordClient(env.DISCORD_BOT_TOKEN, transport)
        self.config = config if config is not None else ConfigStore(env)
        self.ai = Inference(env)

    async def dispatch(self, interaction: dict):
        """Dispatch a verified application command; Discord owns the wire schema."""
        ctx = CommandContext(interaction, self)
        try:
            if not guild_allowed(self.env, interaction.get("guild_id")):
                await ctx.reply("This bot only works in its home server.")
                return
            name = interaction["data"]["name"]
            command = COMMANDS.get(name)
            if not command:
                await ctx.reply("Unknown command.")
                return
            invoker_id = ctx.invoker.get("id")
            if command.admin_only and invoker_id not in ADMIN_IDS:
                await ctx.reply(f"You are not allowed to use /{name}.")
                return
            if command.required_role_id:
                roles = (interaction.get("member") or {}).get("roles")
                if (
                    not interaction.get("guild_id")
                    or not invoker_id
                    or not isinstance(roles, list)
                    or command.required_role_id not in roles
                ):
                    await ctx.reply(
                        f"You are not allowed to use /{name}. The Mods role is required."
                    )
                    return
            await command.execute(ctx)
        except Exception:
            log.error("command_execute_failed")
            try:
                await ctx.reply("Command failed. Try again.")
            except Exception:
                log.warning("command_failure_notice_failed")

    async def handle_message(self, message: dict, bot_user_id: str | None):
        """Handle a Discord MESSAGE_CREATE event or a local simulation of one."""
        if message["author"].get("bot") or not bot_user_id:
            return
        guild_id = message.get("guild_id")
        if not guild_allowed(self.env, guild_id) or not strip_mentions(message.get("content", "")):
            return
        started_at = time.monotonic()
        try:
            content = truncate_discord(message.get("content", ""), 4000)
            reference = message.get("message_reference") or {}
            referenced = message.get("referenced_message") or {}
            reply_id = reference.get("message_id") or referenced.get("id")
            reply_channel = (
                reference.get("channel_id") or referenced.get("channel_id") or message["channel_id"]
            )
            if reply_id and reply_channel == message["channel_id"] and not referenced:
                try:
                    referenced = await self.discord.message(reply_channel, reply_id) or {}
                except Exception:
                    log.warning("reply_context_fetch_failed")
                    referenced = {}
                message = {**message, "referenced_message": referenced or None}
            replying_to_bot = (
                reply_channel == message["channel_id"]
                and (referenced.get("author") or {}).get("id") == bot_user_id
            )

            users = {user["id"] for user in message.get("mentions", [])}
            role_ids = message.get("mention_roles", [])
            bot_roles = (
                await self.discord.bot_roles(guild_id, bot_user_id) if role_ids and guild_id else []
            )
            roles = set(role_ids)
            for marker, identifier in re.findall(r"<@([!&]?)([^>\s]+)>", content):
                (roles if marker == "&" else users).add(identifier)
            if (
                not replying_to_bot
                and bot_user_id not in users
                and self.env.DISCORD_APPLICATION_ID not in users
                and not roles.intersection(bot_roles)
            ):
                return
            prompt = message_text(message, bot_user_id)
            if not prompt:
                return
            user_id = (message.get("author") or {}).get("id")
            reference = message.get("message_reference") or {}
            referenced = message.get("referenced_message") or {}
            job = ChatJob(
                Attribution(
                    "channel_reply",
                    user_id,
                    display_name(message),
                    message["channel_id"],
                    message["id"],
                ),
                prompt,
                bot_user_id,
                reference.get("message_id") or referenced.get("id"),
                reference.get("channel_id") or referenced.get("channel_id"),
                message,
            )
        except Exception:
            log.error("gateway_message_resolve_failed")
            return
        await process_chat(self, job, started_at)
