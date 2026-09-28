"""Application binding contract; generated Workers API hints live in js-stubs."""

from typing import Any, Protocol


class Env(Protocol):
    BUILDER: Any
    BUILDER_ENABLED: str
    DB: Any
    AI_CONFIG: Any
    AI: Any
    DISCORD_GATEWAY: Any
    DISCORD_APPLICATION_ID: str
    ALLOWED_GUILD_IDS: str
    CF_ACCOUNT_ID: str
    CF_AIG_GATEWAY_ID: str
    DISCORD_BOT_TOKEN: str
    DISCORD_PUBLIC_KEY: str
    GATEWAY_CONTROL_TOKEN: str
    CF_AIG_TOKEN: str
