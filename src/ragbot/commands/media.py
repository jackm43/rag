import base64
import logging
import re

from ..discord import MEDIA_MAX_BYTES, Attachment, MediaTooLargeError, download_media, read_media
from ..policy import truncate_discord
from .registry import CommandContext, command, text_option

log = logging.getLogger("ragbot")


def media_string(result, field):
    for _ in range(3):
        if not isinstance(result, dict):
            return None
        value = result.get(field)
        if isinstance(value, str) and value:
            return value
        result = result.get("result")
    return None


async def image_file(result, transport) -> Attachment:
    content_type = "image/jpeg"
    if isinstance(result, (bytes, bytearray, memoryview)):
        data = bytes(result)
    elif hasattr(result, "getReader"):
        data = await read_media(result)
    else:
        value = result if isinstance(result, str) else media_string(result, "image")
        if not value and isinstance(result, dict) and result.get("data"):
            value = result["data"][0].get("b64_json") or result["data"][0].get("url")
        if not value:
            raise ValueError("missing_bicture_image")
        if value.lower().startswith("https://"):
            data, mime = await download_media(value, transport=transport)
            content_type = mime or content_type
        else:
            match = re.fullmatch(r"data:([^;]+);base64,(.+)", value, re.I)
            if match:
                content_type, value = match.groups()
            if len(value) > (MEDIA_MAX_BYTES + 2) // 3 * 4:
                raise MediaTooLargeError("image exceeds 25 MiB")
            data = base64.b64decode(value, validate=True)
    if len(data) > MEDIA_MAX_BYTES:
        raise MediaTooLargeError("image exceeds 25 MiB")
    extension = "png" if "png" in content_type else "webp" if "webp" in content_type else "jpg"
    return Attachment(f"bicture.{extension}", content_type, data)


@command(
    "bicture",
    "Generate an image with Cloudflare AI",
    [text_option("prompt", "Image prompt", 2000)],
    ai_limited=True,
)
async def bicture(ctx: CommandContext):
    prompt = ctx.option("prompt")
    try:
        config = await ctx.app.config.document("bicture-image.json")
        profiles = config["profiles"]
        profile = profiles.get(config["activeProfile"]) or profiles["standard"]
        result = await ctx.app.ai.media(
            profile,
            {
                "prompt": prompt,
                "response_format": profile["responseFormat"],
                "aspect_ratio": profile["aspectRatio"],
                "quality": profile["quality"],
                "resolution": profile["resolution"],
            },
            ctx.attribution("bicture"),
        )
        file = await image_file(result, ctx.app.transport)
        summary = prompt if len(prompt) <= 300 else truncate_discord(prompt, 299) + "..."
        if not await ctx.reply(summary, files=(file,)):
            await ctx.reply(
                "The image was generated, but Discord rejected the upload. Please try again."
            )
    except Exception as error:
        log.error("bicture_command_failed error_type=%s", type(error).__name__)
        await ctx.reply("Could not generate that image. Try a different prompt.")


def prompt_content(prompt: str, prefix: str) -> str:
    available = 2000 - len(prefix.encode("utf-16-le")) // 2
    if len(prompt.encode("utf-16-le")) // 2 > available:
        prompt = truncate_discord(prompt, max(0, available - 3)) + "..."
    return prefix + prompt


@command(
    "ragjam",
    "Generate a song with Cloudflare AI",
    [
        text_option("prompt", "Music style, mood, and scenario", 2000),
        text_option("lyrics", "Song lyrics; omit to auto-generate lyrics", 3500, required=False),
    ],
    ai_limited=True,
)
async def ragjam(ctx: CommandContext):
    prompt, lyrics = ctx.option("prompt"), ctx.option("lyrics")
    try:
        if not prompt:
            await ctx.reply("A music prompt is required.")
            return
        profile = await ctx.app.config.document("ragjam-music.json")
        inputs = {
            "prompt": prompt,
            "is_instrumental": profile["isInstrumental"],
            "lyrics_optimizer": profile["lyricsOptimizer"] if lyrics else True,
        }
        if lyrics:
            inputs["lyrics"] = lyrics
        result = await ctx.app.ai.media(profile, inputs, ctx.attribution("ragjam"))
        url = media_string(result, "audio")
        if not url:
            raise ValueError("missing_ragjam_audio")
        file = None
        try:
            data, mime = await download_media(url, transport=ctx.app.transport)
            mime = mime or "audio/mpeg"
            extension = (
                "wav" if "wav" in mime or re.search(r"\.wav(?:$|[?#])", url, re.I) else "mp3"
            )
            file = Attachment(f"ragjam.{extension}", mime, data)
        except Exception:
            log.warning("ragjam_audio_download_failed")
        await ctx.reply(
            prompt_content(prompt, "Prompt: " if file else f"Generated song: {url}\nPrompt: "),
            files=(file,) if file else (),
        )
    except Exception:
        log.error("ragjam_command_failed")
        await ctx.reply("Could not generate that song. Try a different prompt or lyrics.")
