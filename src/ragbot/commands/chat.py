import logging

from ..ai import Attribution
from ..conversation import deliver_reply, thread_title
from .registry import CommandContext, command, text_option

log = logging.getLogger("ragbot")


@command(
    "ask",
    "Start an AI conversation in a new thread",
    [text_option("prompt", "Question or topic for the new thread", 6000)],
    ai_limited=True,
)
async def ask(ctx: CommandContext):
    prompt = ctx.option("prompt")
    parent_id = ctx.interaction.get("channel_id")
    if not parent_id:
        await ctx.reply("Run /ask in a server channel so I can create a thread.")
        return
    channel = await ctx.app.discord.channel(parent_id)
    if channel and channel.get("type") in (10, 11, 12) and channel.get("parent_id"):
        parent_id = channel["parent_id"]
    title = thread_title(prompt)
    try:
        thread = await ctx.app.discord.create_thread(parent_id, title)
    except Exception:
        thread = None
        log.warning("ask_thread_create_failed")
    if not thread or not isinstance(thread.get("id"), str):
        await ctx.reply("I could not create a thread for that question.")
        return
    username, user_id = ctx.display_name, ctx.invoker.get("id")
    try:
        await ctx.db.record_thread(
            {
                "thread_id": thread["id"],
                "parent_channel_id": parent_id,
                "requester_user_id": user_id,
                "requester_username": username,
                "initial_prompt": prompt,
                "title": title,
            }
        )
    except Exception:
        log.warning("ask_thread_record_failed")
    await ctx.reply(f"Started <#{thread['id']}>")
    attribution = Attribution("ask", user_id, username, thread["id"])
    ok = await deliver_reply(
        ctx.app,
        attribution,
        prompt,
        lambda: ctx.app.ai.ask(
            prompt,
            username,
            [{"role": "user", "content": f"{username}: {prompt}"}],
            attribution,
            web_context=[],
        ),
    )
    if not ok:
        try:
            await ctx.app.discord.reply(
                thread["id"],
                "I started this thread, but the AI response failed. Try again in a moment.",
            )
        except Exception:
            log.warning("ask_failure_notice_failed")
