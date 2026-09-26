"""Pure Discord output policy, shared by every AI reply."""

import re


def sanitize_ai_text(value: str) -> str:
    lines = value.lstrip("\n \t\r").split("\n")
    if lines:
        first = lines[0].strip()
        colon = first.find(":")
        if 0 < colon <= 32 and first[colon + 1 :].lstrip():
            lines[0] = first[colon + 1 :].lstrip()
    text = "\n".join(lines)
    text = re.sub(r"<@[!&]?[0-9]+>", "", text)
    text = re.sub(r"\b[0-9]{17,20}\b", "", text)
    text = re.sub(r"@(everyone|here)", r"\1", text)
    text = "\n".join(re.sub(r"[ \t]+", " ", line).strip() for line in text.split("\n"))
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def suppress_url_embeds(text: str) -> str:
    def wrap(match: re.Match) -> str:
        url = match.group()
        if url.startswith("<"):
            return url
        suffix = ""
        while url and url[-1] in ".,!?;:":
            suffix = url[-1] + suffix
            url = url[:-1]
        while url.endswith(")") and url.count(")") > url.count("("):
            suffix = ")" + suffix
            url = url[:-1]
        return f"<{url}>{suffix}"

    segments = re.split(r"(```[\s\S]*?```|`[^`\n]*`)", text)
    return "".join(
        part if i % 2 else re.sub(r"<?https?://[^\s<>]+>?", wrap, part)
        for i, part in enumerate(segments)
    )


def truncate_discord(text: str, limit: int) -> str:
    # Discord's existing JS client limits UTF-16 code units. Avoid splitting emoji.
    return text.encode("utf-16-le")[: limit * 2].decode("utf-16-le", errors="ignore")


def finalize_ai_reply(value: str) -> str:
    return (
        truncate_discord(suppress_url_embeds(sanitize_ai_text(value)), 1900)
        or "I could not generate a response."
    )
