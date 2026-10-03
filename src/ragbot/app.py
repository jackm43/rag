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
            invoker_id = ctx.invoker["id"]
            if command.admin_only and invoker_id not in ADMIN_IDS:
                await ctx.reply(f"You are not allowed to use /{name}.")
                return
            if command.required_role_id:
                member = interaction.get("member")
                if member is None or command.required_role_id not in member["roles"]:
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
        if not guild_allowed(self.env, guild_id) or not strip_mentions(message["content"]):
            return
        started_at = time.monotonic()
        try:
            channel_id = message["channel_id"]
            content = truncate_discord(message["content"], 4000)
            reference = message.get("message_reference", {})
            reply_id = reference.get("message_id")
            reply_channel = reference.get("channel_id", channel_id)
            referenced = message.get("referenced_message")
            if reply_id and reply_channel == channel_id and referenced is None:
                try:
                    referenced = await self.discord.message(channel_id, reply_id)
                except Exception:
                    log.warning("reply_context_fetch_failed")
                message = {**message, "referenced_message": referenced}
            replying_to_bot = (
                reply_channel == channel_id
                and referenced is not None
                and referenced["author"]["id"] == bot_user_id
            )

            users = {user["id"] for user in message.get("mentions", [])}
            roles = set(message.get("mention_roles", []))
            for marker, identifier in re.findall(r"<@([!&]?)([^>\s]+)>", content):
                if marker == "&":
                    roles.add(identifier)
                else:
                    users.add(identifier)
            mentioned = bool(users.intersection({bot_user_id, self.env.DISCORD_APPLICATION_ID}))
            if not replying_to_bot and not mentioned and roles and guild_id:
                bot_roles = await self.discord.bot_roles(guild_id, bot_user_id)
                mentioned = bool(roles.intersection(bot_roles))
            if not replying_to_bot and not mentioned:
                return
            prompt = message_text(message, bot_user_id)
            if not prompt:
                return
            job = ChatJob(
                Attribution(
                    "channel_reply",
                    message["author"]["id"],
                    display_name(message),
                    channel_id,
                    message["id"],
                ),
                prompt,
                bot_user_id,
                reply_id,
                reply_channel,
                message,
            )
        except Exception:
            log.error("gateway_message_resolve_failed")
            return
        await process_chat(self, job, started_at)
