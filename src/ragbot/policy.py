"""Discord reply length and empty-response handling."""


def truncate_discord(text: str, limit: int) -> str:
    # Discord's existing JS client limits UTF-16 code units. Avoid splitting emoji.
    return text.encode("utf-16-le")[: limit * 2].decode("utf-16-le", errors="ignore")


def finalize_ai_reply(value: str) -> str:
    if not value.strip():
        return "I could not generate a response."
    return truncate_discord(value, 1900)
