"""Explicit reply context and delivery for mentions and replies."""

import logging
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from .ai import Attribution, Completion
from .policy import finalize_ai_reply, truncate_discord

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


@dataclass
class ChatJob:
    attribution: Attribution
    prompt: str
    bot_user_id: str
    reply_message_id: str | None = None
    reply_channel_id: str | None = None
    source_message: dict | None = None


def message_text(message: dict, bot_user_id: str) -> str:
    names = {
        user["id"]: display_name({"author": user})
        for user in message.get("mentions", [])
        if isinstance(user, dict) and user.get("id")
    }

    def mention(match):
        marker, identifier = match.groups()
        if identifier == bot_user_id:
            return ""
        return names.get(identifier, "[role]" if marker == "&" else "[user]")

    text = re.sub(r"<@([!&]?)([^>\s]+)>", mention, message.get("content", ""))
    parts = [text.strip()] if text.strip() else []
    for attachment in message.get("attachments", [])[:5]:
        parts.append(f"[attachment: {attachment.get('filename', 'file')}; contents not provided]")
    return truncate_discord("\n".join(parts), 4000)


async def build_conversation(app, job: ChatJob, history_limit: int) -> list[dict]:
    a = job.attribution
    limit = max(1, min(history_limit, 12))
    chain = []
    seen = {a.message_id}
    reference_id = job.reply_message_id
    channel_id = job.reply_channel_id or a.channel_id
    embedded = (job.source_message or {}).get("referenced_message")
    for _ in range(limit):
        # Explicit reply ancestry only; never widen a channel request to nearby chatter.
        if not reference_id or reference_id in seen or channel_id != a.channel_id:
            break
        seen.add(reference_id)
        referenced = (
            embedded if isinstance(embedded, dict) and embedded.get("id") == reference_id else None
        )
        if referenced is None:
            try:
                referenced = await app.discord.message(channel_id, reference_id)
            except Exception:
                log.warning("reply_context_fetch_failed")
                break
        if (
            not referenced
            or referenced.get("id") != reference_id
            or referenced.get("channel_id") != a.channel_id
        ):
            break
        chain.append(referenced)
        reference = referenced.get("message_reference") or {}
        embedded = referenced.get("referenced_message")
        reference_id = reference.get("message_id") or (embedded or {}).get("id")
        channel_id = reference.get("channel_id") or a.channel_id

    ordered = list(reversed(chain))
    names = {}
    for message in ordered:
        author_id = (message.get("author") or {}).get("id")
        if author_id:
            names[author_id] = display_name(message)
    if a.user_id:
        names[a.user_id] = a.username or "user"
    messages: list[dict] = []
    for message in ordered:
        content = message_text(message, job.bot_user_id)
        if not content:
            continue
        author_id = (message.get("author") or {}).get("id")
        if author_id == job.bot_user_id:
            if re.search(r"\b(?:has )?just ragged\.", content) or content.startswith("Ragboard\n"):
                continue
            messages.append({"role": "assistant", "content": content})
        else:
            messages.append(
                {"role": "user", "content": f"{names.get(author_id, 'user')}: {content}"}
            )
    prompt = message_text(job.source_message, job.bot_user_id) if job.source_message else job.prompt
    messages.append({"role": "user", "content": f"{a.username or 'user'}: {prompt}"})
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
        ai_start = time.monotonic()
        result = await complete()
        ai_duration = round((time.monotonic() - ai_start) * 1000)
        model, usage = result.model, result.usage or {}
        response_text = finalize_ai_reply(result.content)
        response = await app.discord.post_message(
            attribution.channel_id, response_text, reply_to=attribution.message_id
        )
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
        chat = await app.config.chat()
        messages = await build_conversation(app, job, chat.history_limit)
        return await app.ai.chat(
            chat, [{"role": "system", "content": chat.prompt}, *messages], job.attribution
        )

    await deliver_reply(app, job.attribution, job.prompt, complete, started_at=started_at)
