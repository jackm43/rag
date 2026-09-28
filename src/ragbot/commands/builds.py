"""App build commands. `@Ragbot build ...` is the main entry point; these
mirror it and add management. Inside an app's workspace thread the build ID
can be omitted."""

from ..builds import BuildScope, build_guild, status_text
from .registry import MODS_ROLE_ID, CommandContext, command, text_option

REQUEST = text_option(
    "request", "Build ID (not needed in the app's workspace thread)", 32, minimum=32, required=False
)
UNAVAILABLE = "App builds are only available in this server's channels."


def scope_for(ctx: CommandContext) -> BuildScope | None:
    guild = ctx.interaction.get("guild_id") or ""
    member = ctx.interaction.get("member") or {}
    roles = member.get("roles")
    if not build_guild(ctx.app.env, guild):
        return None
    try:
        return BuildScope(
            guild,
            ctx.interaction.get("channel_id") or "",
            (member.get("user") or {}).get("id") or "",
            isinstance(roles, list) and MODS_ROLE_ID in roles,
        )
    except ValueError:
        return None


async def resolve(ctx: CommandContext) -> tuple[BuildScope, dict] | None:
    scope = scope_for(ctx)
    if scope is None:
        await ctx.reply(UNAVAILABLE)
        return None
    request = ctx.option("request")
    builds = ctx.app.builds
    row = await (builds.find(scope, request) if request else builds.in_thread(scope))
    if row is None:
        await ctx.reply(
            "Use this in the app's workspace thread, or give its build ID in the channel "
            "where it was requested."
        )
        return None
    return scope, row


@command(
    "build", "Build a web app for this server", [text_option("prompt", "Describe the app", 6000)]
)
async def build(ctx: CommandContext):
    scope = scope_for(ctx)
    if scope is None:
        await ctx.reply(UNAVAILABLE)
        return
    await ctx.reply(
        await ctx.app.builds.start(
            scope,
            ctx.interaction.get("id") or "",
            ctx.option("prompt"),
            ctx.display_name,
            ctx.app.discord,
        )
    )


@command("buildstatus", "Check on an app build", [REQUEST])
async def buildstatus(ctx: CommandContext):
    if found := await resolve(ctx):
        await ctx.reply(status_text(await ctx.app.builds.refresh(found[1])))


@command(
    "buildedit",
    "Ask for a change to an app",
    [text_option("prompt", "Describe the change", 6000), REQUEST],
)
async def buildedit(ctx: CommandContext):
    if found := await resolve(ctx):
        scope, row = found
        await ctx.reply(
            await ctx.app.builds.change(
                scope, row, ctx.option("prompt"), ctx.interaction.get("id") or ""
            )
        )


async def manage(ctx: CommandContext, action: str, **options):
    if not (found := await resolve(ctx)):
        return
    scope, row = found
    try:
        row = await ctx.app.builds.manage(scope, row, action, **options)
    except PermissionError:
        await ctx.reply("Only the app's owner or Mods can do that.")
    except Exception:
        await ctx.reply("That didn't work. Check the build with `/buildstatus` and try again.")
    else:
        await ctx.reply(status_text(row))


@command("buildcancel", "Stop a running app build", [REQUEST])
async def buildcancel(ctx: CommandContext):
    await manage(ctx, "cancel")


@command(
    "buildrollback",
    "Restore an earlier version of an app",
    [text_option("revision", "Revision number to restore", 8), REQUEST],
)
async def buildrollback(ctx: CommandContext):
    try:
        revision = int(ctx.option("revision"))
    except ValueError:
        await ctx.reply("Enter a revision number, like 1.")
        return
    await manage(ctx, "rollback", revision=revision)


@command("builddelete", "Delete an app and its shared data", [REQUEST])
async def builddelete(ctx: CommandContext):
    await manage(ctx, "delete")
