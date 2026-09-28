"""Application composition and ingress workflows; no global event loop."""

import logging
import re
import time

from .ai import Attribution, Inference
from .builds import BuildRequests, BuildScope, build_status_text
from .commands import COMMANDS, CommandContext
from .commands.registry import ADMIN_IDS, MODS_ROLE_ID
from .config import ConfigStore
from .conversation import ChatJob, display_name, message_text, process_chat, strip_mentions
from .db import Database, guild_allowed
from .discord import DiscordClient, Transport, is_message
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
        self.builds = BuildRequests(self.db, env, self.config)
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
        if not is_message(message) or (message.get("author") or {}).get("bot") or not bot_user_id:
            return
        guild_id = message.get("guild_id")
        if not guild_allowed(self.env, guild_id) or not strip_mentions(message.get("content", "")):
            return
        directed = re.fullmatch(
            rf"<@!?{re.escape(bot_user_id)}>\s+([\s\S]+)",
            message.get("content", "").strip(),
        )
        if directed and guild_id and not message.get("webhook_id"):
            configured = getattr(self.env, "ALLOWED_GUILD_IDS", "") or ""
            if guild_id not in {value.strip() for value in configured.split(",")}:
                return
            try:
                scope = BuildScope(guild_id, message["channel_id"], message["author"]["id"])
                project = await self.builds.in_thread(scope)
                if project:
                    prompt = directed[1].strip()
                    if prompt.lower() in ("status", "progress", "help"):
                        current = await self.builds.sync(project)
                        text = build_status_text(current)
                    elif not 1 <= len(prompt) <= 6000:
                        text = "Describe the change in 1–6000 characters."
                    else:
                        roles = (message.get("member") or {}).get("roles", [])
                        moderator = isinstance(roles, list) and MODS_ROLE_ID in roles
                        if scope.user_id != project["requester_user_id"] and not moderator:
                            text = "The app owner or Mods can request changes. You can discuss bugs here for them to pick up."
                        else:
                            try:
                                result = await self.builds.manage(
                                    scope,
                                    project["id"],
                                    "edit",
                                    moderator=moderator,
                                    prompt=prompt,
                                    source_id=message["id"],
                                )
                                text = f"Working on that change (revision {result.get('revision', 1)}). The current release stays live."
                            except Exception:
                                text = "Could not start that change. A build may already be running; use `/buildstatus` here and try again when it finishes."
                    await self.discord.post_message(scope.channel_id, text, reply_to=message["id"])
                    return
            except Exception:
                log.warning("build_thread_resolve_failed")
                return  # Fail closed rather than route a possible edit into ordinary chat.
        build_match = re.fullmatch(
            rf"<@!?{re.escape(bot_user_id)}>\s+(build|feature)\s+([\s\S]+)",
            message.get("content", "").strip(),
            re.IGNORECASE,
        )
        if build_match and guild_id and not message.get("webhook_id"):
            configured = getattr(self.env, "ALLOWED_GUILD_IDS", "") or ""
            if guild_id not in {value.strip() for value in configured.split(",")}:
                return
            try:
                scope = BuildScope(guild_id, message["channel_id"], message["author"]["id"])
                row = await self.builds.submit(
                    scope,
                    message["id"],
                    "site" if build_match[1].lower() == "build" else "feature",
                    build_match[2],
                )
                try:
                    row = await self.builds.sync(row)
                except Exception:
                    log.warning("build_submission_pending")
                row = await self.builds.ensure_thread(row, self.discord)
                await self.discord.post_message(
                    message["channel_id"], build_status_text(row), reply_to=message["id"]
                )
            except Exception:
                log.warning("build_mention_failed")
                await self.discord.post_message(
                    message["channel_id"], "Could not save that build request."
                )
            return
        started_at = time.monotonic()
        try:
            content = truncate_discord(message.get("content", ""), 4000)
            thread = await self.db.find_thread(message["channel_id"]) if guild_id else None
            reference = message.get("message_reference") or {}
            referenced = message.get("referenced_message") or {}
            reply_id = reference.get("message_id") or referenced.get("id")
            reply_channel = (
                reference.get("channel_id") or referenced.get("channel_id") or message["channel_id"]
            )
            if (
                not thread
                and reply_id
                and reply_channel == message["channel_id"]
                and not referenced
            ):
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
            kind = "thread_reply" if thread else "channel_reply"
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
                message,
            )
        except Exception:
            log.error("gateway_message_resolve_failed")
            return
        await process_chat(self, job, started_at)
