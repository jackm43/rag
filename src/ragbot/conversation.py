"""Thread context and reply delivery, shared by slash commands and mentions."""

import logging
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from .ai import Attribution, Completion
from .policy import finalize_ai_reply, sanitize_ai_text, truncate_discord

log = logging.getLogger("ragbot")


def strip_mentions(content: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<@[!&]?[^>\s]+>", " ", content)).strip()


def display_name(message: dict) -> str:
    author = message.get("author") or {}
    for value in (
        (message.get("member") or {}).get("nick"),
        author.get("global_name"),
        author.get("username"),
    ):
        if isinstance(value, str) and value.strip():
            return value.strip()
    return "user"


def thread_title(prompt: str) -> str:
    title = re.sub(
        r"\s+", " ", sanitize_ai_text(prompt).split("\n")[0].lstrip("\"'`").rstrip("\"'`.!?")
    ).strip()
    if not title:
        return "Chat with Ragbot"
    if len(title.encode("utf-16-le")) > 160:
        title = truncate_discord(title, 80).strip()
        if title.rfind(" ") >= 24:
            title = title[: title.rfind(" ")].strip()
    return title


@dataclass
class ChatJob:
    attribution: Attribution
    prompt: str
    bot_user_id: str
    thread: dict | None = None
    reply_message_id: str | None = None
    reply_channel_id: str | None = None


async def build_conversation(app, job: ChatJob, history_limit: int) -> list[dict]:
    a = job.attribution
    messages: list[dict] = []
    history: list[dict] = []
    if job.thread and job.thread.get("initial_prompt"):
        messages.append(
            {
                "role": "user",
                "content": f"{job.thread.get('requester_username') or 'user'}: {job.thread['initial_prompt']}",
            }
        )
    if job.thread and a.message_id:
        try:
            history = await app.discord.messages(
                a.channel_id, before=a.message_id, limit=history_limit
            )
        except Exception:
            log.warning("history_fetch_failed")
    for message in reversed(history):
        content = truncate_discord(strip_mentions(message.get("content", "")), 600)
        if not content:
            continue
        author_id = (message.get("author") or {}).get("id")
        if author_id == job.bot_user_id:
            if re.search(
                r"\bhas just ragged\.(?:\s+Total: [0-9]+)?(?=\s|$)", content
            ) or content.lstrip().startswith("Ragboard\n"):
                continue
            messages.append({"role": "assistant", "content": content})
        else:
            name = a.username if author_id == a.user_id and a.username else display_name(message)
            messages.append({"role": "user", "content": f"{name}: {content}"})
    prompt_parts = []
    if job.reply_message_id and job.reply_message_id not in {m["id"] for m in history}:
        try:
            referenced = await app.discord.message(
                job.reply_channel_id or a.channel_id, job.reply_message_id
            )
        except Exception:
            referenced = None
            log.warning("reply_context_fetch_failed")
        if referenced:
            parts = [referenced["content"].strip()] if referenced.get("content", "").strip() else []
            for attachment in referenced.get("attachments", []):
                content_type = (
                    f" ({attachment['content_type']})" if attachment.get("content_type") else ""
                )
                url = f" {attachment['url']}" if attachment.get("url") else ""
                parts.append(f"Attachment: {attachment['filename']}{content_type}{url}")
            if parts:
                author = (referenced.get("author") or {}).get("username", "").strip()
                label = f"Replied-to message from {author}:" if author else "Replied-to message:"
                prompt_parts.append(label + "\n" + "\n".join(parts))
    prompt_parts.append(f"{a.username or 'user'}: {job.prompt}")
    messages.append({"role": "user", "content": "\n\n".join(prompt_parts)})
    return messages


async def deliver_reply(
    app,
    attribution: Attribution,
    prompt: str,
    complete: Callable[[], Awaitable[Completion]],
    *,
    started_at: float | None = None,
) -> bool:
    started_at = time.monotonic() if started_at is None else started_at
    model, status, response_text, error, usage, ai_duration = "unknown", "ok", None, None, {}, None
    try:
        chat, _ = await app.config.models()
        model = chat.model
        ai_start = time.monotonic()
        result = await complete()
        ai_duration = round((time.monotonic() - ai_start) * 1000)
        model, usage = result.model, result.usage or {}
        response_text = finalize_ai_reply(result.content)
        response = await app.discord.post_message(attribution.channel_id, response_text)
        if not response.ok:
            raise RuntimeError(f"discord_channel_post_failed_{response.status}")
    except Exception as exc:
        status = "error"
        # Third-party errors may contain credential-bearing URLs or payloads.
        error = type(exc).__name__
        log.error("ai_job_failed error_type=%s", error)
    try:
        await app.db.run(
            "INSERT INTO rag_ai_interactions (kind, channel_id, message_id, requester_user_id, requester_username, prompt, response_text, model, ai_duration_ms, total_duration_ms, status, error_message, prompt_tokens, completion_tokens, total_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            attribution.kind,
            attribution.channel_id,
            attribution.message_id,
            attribution.user_id,
            attribution.username,
            prompt,
            response_text,
            model,
            ai_duration,
            round((time.monotonic() - started_at) * 1000),
            status,
            error,
            *(usage.get(k) for k in ("prompt_tokens", "completion_tokens", "total_tokens")),
        )
    except Exception:
        log.warning("interaction_record_failed")
    return status == "ok"


async def process_chat(app, job: ChatJob, started_at: float):
    async def complete():
        chat, _ = await app.config.models()
        messages = await build_conversation(app, job, chat.history_limit)
        if job.thread and not job.thread.get("source_message_id"):
            return await app.ai.ask(
                job.prompt, job.attribution.username or "user", messages, job.attribution
            )
        system = (
            chat.prompt
            + '\n\nThis is a normal chat reply, not the /rag command. Use only the provided thread conversation context and the current user message; do not infer context from unrelated channel history. Do not include rag counts, leaderboard totals, or phrases like "has just ragged" unless the user explicitly asks about the rag leaderboard. If the same user appears under different account names, global names, or nicknames in context, treat them as one person and do not mention multiple aliases in the same reply.'
        )
        return await app.ai.chat(
            chat, [{"role": "system", "content": system}, *messages], job.attribution
        )

    await deliver_reply(app, job.attribution, job.prompt, complete, started_at=started_at)
