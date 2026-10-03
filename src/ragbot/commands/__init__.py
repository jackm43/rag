"""The command registry is shared by dispatch and Discord registration."""

from . import coinflip, media, moderation  # noqa: F401
from .registry import COMMANDS, CommandContext, command

__all__ = ["COMMANDS", "CommandContext", "command"]
