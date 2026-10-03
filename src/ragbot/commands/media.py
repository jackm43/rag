import base64
import logging
import time

from ..discord import MEDIA_MAX_BYTES, Attachment, MediaTooLargeError, download_media, read_media
from ..policy import truncate_discord
from .registry import CommandContext, command, text_option

log = logging.getLogger("ragbot")


def image_source(result) -> str:
    """Read the documented image/base64/URL fields from provider envelopes."""
    for _ in range(3):
        match result:
            case str(value) | {"image": str(value)} if value:
                return value
            case {"data": [{"b64_json": str(value)}, *_]} if value:
                return value
            case {"data": [{"url": str(value)}, *_]} if value:
                return value
            case {"result": nested}:
                result = nested
            case _:
                break
    raise ValueError("missing_bicture_image")


async def image_file(result, transport) -> Attachment:
    content_type = "image/jpeg"
    match result:
        case bytes() | bytearray() | memoryview():
            data = bytes(result)
        case stream if hasattr(stream, "getReader"):
            data = await read_media(stream)
        case _:
            value = image_source(result)
            if value.lower().startswith("https://"):
                data, mime = await download_media(value, transport=transport)
                content_type = mime or content_type
            else:
                if value.lower().startswith("data:"):
                    metadata, separator, value = value.partition(",")
                    if not separator or not metadata.lower().endswith(";base64"):
                        raise ValueError("invalid image data URI")
                    content_type = metadata[5:-7]
                    if not content_type or not value:
                        raise ValueError("invalid image data URI")
                if len(value) > (MEDIA_MAX_BYTES + 2) // 3 * 4:
                    raise MediaTooLargeError("image exceeds 25 MiB")
                data = base64.b64decode(value, validate=True)
    if len(data) > MEDIA_MAX_BYTES:
        raise MediaTooLargeError("image exceeds 25 MiB")
    match content_type.split(";")[0].strip():
        case "image/png":
            extension = "png"
        case "image/webp":
            extension = "webp"
        case _:
            extension = "jpg"
    return Attachment(f"bicture.{extension}", content_type, data)


@command(
    "bicture",
    "Generate an image with Cloudflare AI",
    [text_option("prompt", "Image prompt", 2000)],
)
async def bicture(ctx: CommandContext):
    prompt = ctx.option("prompt")
    attribution = ctx.attribution("bicture")
    started_at = time.monotonic()
    model, status, error_type = "unknown", "ok", None
    try:
        snapshot = await ctx.app.config.snapshot()
        config = ctx.app.config.document_from(snapshot, "bicture-image.json")
        profile = config["profiles"][config["activeProfile"]]
        model = profile["model"]
        parameters = profile.get("parameters")
        if parameters is None:
            parameters = {
                "response_format": profile["responseFormat"],
                "aspect_ratio": profile["aspectRatio"],
                "quality": profile["quality"],
                "resolution": profile["resolution"],
            }
        result = await ctx.app.ai.media(
            profile,
            {**parameters, "prompt": prompt},
            attribution,
            settings_revision=snapshot["revision"],
        )
        file = await image_file(result, ctx.app.transport)
        summary = prompt if len(prompt) <= 300 else truncate_discord(prompt, 299) + "..."
        if not await ctx.reply(summary, files=(file,)):
            status, error_type = "error", "DiscordUploadRejected"
            await ctx.reply(
                "The image was generated, but Discord rejected the upload. Please try again."
            )
    except Exception as error:
        status, error_type = "error", type(error).__name__
        log.error("bicture_command_failed error_type=%s", type(error).__name__)
        await ctx.reply("Could not generate that image. Try a different prompt.")
    finally:
        try:
            await ctx.app.db.run(
                "INSERT INTO rag_ai_interactions (kind, channel_id, message_id, requester_user_id, requester_username, prompt, model, total_duration_ms, status, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                "bicture",
                attribution.channel_id,
                attribution.message_id,
                attribution.user_id,
                attribution.username,
                prompt,
                model,
                round((time.monotonic() - started_at) * 1000),
                status,
                error_type,
            )
        except Exception:
            log.warning("interaction_record_failed")
