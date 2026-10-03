from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from functools import cached_property
from typing import Any

from ..ai import Attribution
from ..discord import Attachment


@dataclass(frozen=True)
class Command:
    data: dict
    execute: Callable[["CommandContext"], Awaitable[None]]
    admin_only: bool = False
    required_role_id: str | None = None


MODS_ROLE_ID = "457695154892177418"
COMMANDS: dict[str, Command] = {}
ADMIN_IDS = frozenset(
    {"107426926909517824", "116163000339136518", "102637456385392640", "114128631474683907"}
)


def command(
    name: str,
    description: str,
    options: list[dict] | None = None,
    *,
    admin_only: bool = False,
    required_role_id: str | None = None,
):
    def register(handler):
        data: dict = {"name": name, "description": description}
        if options:
            data["options"] = options
        if name in COMMANDS:
            raise ValueError(f"Duplicate command {name}")
        COMMANDS[name] = Command(data, handler, admin_only, required_role_id)
        return handler

    return register


def user_option(description: str) -> dict:
    return {"type": 6, "name": "user", "description": description, "required": True}


def text_option(
    name: str, description: str, maximum: int, *, minimum: int = 1, required: bool = True
) -> dict:
    return {
        "type": 3,
        "name": name,
        "description": description,
        "required": required,
        "min_length": minimum,
        "max_length": maximum,
    }


@dataclass
class CommandContext:
    interaction: dict
    app: Any

    @property
    def db(self):
        return self.app.db

    @cached_property
    def invoker(self) -> dict:
        member = self.interaction.get("member")
        return member["user"] if member else self.interaction["user"]

    @cached_property
    def display_name(self) -> str:
        member = self.interaction.get("member") or {}
        return (
            member.get("nick")
            or self.invoker.get("global_name")
            or self.invoker.get("username")
            or "user"
        ).strip() or "user"

    def option(self, name: str) -> str:
        for option in self.interaction["data"].get("options", []):
            if option["name"] == name:
                return option["value"].strip()
        return ""

    async def target_username(self, target_id: str) -> str | None:
        resolved = self.interaction.get("data", {}).get("resolved", {}).get("users", {})
        return (resolved.get(target_id) or {}).get("username") or await self.app.discord.username(
            target_id
        )

    def attribution(self, kind: str, *, channel_id: str | None = None) -> Attribution:
        return Attribution(
            kind,
            self.invoker.get("id"),
            self.display_name,
            channel_id or self.interaction.get("channel_id"),
            self.interaction.get("id"),
        )

    async def reply(
        self,
        content: str,
        *,
        users: list[str] | None = None,
        files: tuple[Attachment, ...] = (),
        followup: bool = False,
    ):
        return await self.app.discord.write_interaction(
            self.interaction["application_id"],
            self.interaction["token"],
            content,
            edit=not followup,
            users=users,
            files=files,
        )
