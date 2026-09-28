"""Coding request commands. Intake is available before execution is connected."""

from ..builds import BuildScope, build_status_text
from ..runtime import env_value
from .registry import MODS_ROLE_ID, CommandContext, command, text_option


def scope_for(ctx: CommandContext) -> BuildScope | None:
    # Unlike ordinary chat, coding intake requires an explicitly configured guild.
    allowed = env_value(ctx.app.env, "ALLOWED_GUILD_IDS", "").split(",")
    guild = ctx.interaction.get("guild_id") or ""
    member = ctx.interaction.get("member") or {}
    user = (member.get("user") or {}).get("id") or ""
    if not guild or guild not in {value.strip() for value in allowed}:
        return None
    try:
        return BuildScope(guild, ctx.interaction.get("channel_id") or "", user)
    except ValueError:
        return None


async def submit(ctx: CommandContext, kind: str):
    scope = scope_for(ctx)
    if scope is None:
        await ctx.reply("Use this command as a member in a configured server channel.")
        return
    prompt = ctx.option("prompt")
    if not 1 <= len(prompt) <= 6000:
        await ctx.reply("Describe your request in 1–6000 characters.")
        return
    result = await ctx.app.builds.submit(scope, ctx.interaction.get("id") or "", kind, prompt)
    try:
        result = await ctx.app.builds.sync(result)
    except Exception:
        pass  # The durable request remains available to reconciliation.
    result = await ctx.app.builds.ensure_thread(result, ctx.app.discord)
    await ctx.reply(build_status_text(result))


@command(
    "build",
    "Build and deploy a guild app or game",
    [text_option("prompt", "Describe what you want built", 6000)],
)
async def build(ctx: CommandContext):
    await submit(ctx, "site")


@command(
    "feature",
    "Implement a Ragbot feature as a draft PR",
    [text_option("prompt", "Describe the Ragbot change", 6000)],
)
async def feature(ctx: CommandContext):
    await submit(ctx, "feature")


@command(
    "buildstatus",
    "Check a coding request from this channel",
    [
        text_option(
            "request", "Request reference (omit in app thread)", 32, minimum=32, required=False
        )
    ],
)
async def buildstatus(ctx: CommandContext):
    scope = scope_for(ctx)
    if scope is None:
        await ctx.reply("Use this command as a member in a configured server channel.")
        return
    result = (
        await ctx.app.builds.status(scope, ctx.option("request"))
        if ctx.option("request")
        else await ctx.app.builds.in_thread(scope)
    )
    if result is None:
        await ctx.reply("Request not found in this channel.")
        return
    try:
        result = await ctx.app.builds.sync(result)
    except Exception:
        pass
    result = await ctx.app.builds.ensure_thread(result, ctx.app.discord)
    await ctx.reply(build_status_text(result))


async def manage(ctx: CommandContext, action: str):
    scope = scope_for(ctx)
    if scope is None:
        await ctx.reply("Use this command in a configured server channel.")
        return
    request_id = ctx.option("request")
    if not request_id:
        row = await ctx.app.builds.in_thread(scope)
        if row is None:
            await ctx.reply("Use this command in an app workspace, or supply its request ID.")
            return
        request_id = row["id"]
    roles = (ctx.interaction.get("member") or {}).get("roles", [])
    options = {}
    if action == "edit":
        options = {"prompt": ctx.option("prompt"), "source_id": ctx.interaction["id"]}
    if action == "rollback":
        try:
            options = {"revision": int(ctx.option("revision"))}
        except ValueError:
            await ctx.reply("Enter a valid revision number.")
            return
    try:
        result = await ctx.app.builds.manage(
            scope,
            request_id,
            action,
            moderator=isinstance(roles, list) and MODS_ROLE_ID in roles,
            **options,
        )
    except Exception:
        await ctx.reply(
            "That action is unavailable. Check the request, its status, and your access."
        )
        return
    if action == "passcode":
        await ctx.reply(
            f"Your personal login code: `{result['code']}`. It expires in ten minutes and works once."
        )
    else:
        await ctx.reply(
            f"Build `{request_id}`: {result['status']} (revision {result.get('revision', 1)})."
        )


REQUEST_OPTION = text_option(
    "request", "Build reference (omit in app thread)", 32, minimum=32, required=False
)


@command("buildcancel", "Stop your build", [REQUEST_OPTION])
async def buildcancel(ctx: CommandContext):
    await manage(ctx, "cancel")


@command(
    "buildedit",
    "Build a new revision",
    [text_option("prompt", "Describe the change", 6000), REQUEST_OPTION],
)
async def buildedit(ctx: CommandContext):
    await manage(ctx, "edit")


@command(
    "buildrollback",
    "Restore a previous release",
    [text_option("revision", "Revision number", 8), REQUEST_OPTION],
)
async def buildrollback(ctx: CommandContext):
    await manage(ctx, "rollback")


@command("buildpass", "Get a private one-use login code", [REQUEST_OPTION])
async def buildpass(ctx: CommandContext):
    await manage(ctx, "passcode")


@command("builddelete", "Delete your app, source and room data", [REQUEST_OPTION])
async def builddelete(ctx: CommandContext):
    await manage(ctx, "delete")
