"""The command registry is shared by dispatch and Discord registration."""

from . import chat, media, moderation  # noqa: F401
from .registry import COMMANDS, CommandContext, command

__all__ = ["COMMANDS", "CommandContext", "command"]
