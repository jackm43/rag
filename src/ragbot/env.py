"""Application binding contract; generated Workers API hints live in js-stubs."""

from typing import Any, Protocol


class Env(Protocol):
    DB: Any
    AI: Any
    DISCORD_GATEWAY: Any
    DISCORD_APPLICATION_ID: str
    ALLOWED_GUILD_IDS: str
    CF_ACCOUNT_ID: str
    DISCORD_BOT_TOKEN: str
    DISCORD_PUBLIC_KEY: str
    GATEWAY_CONTROL_TOKEN: str
