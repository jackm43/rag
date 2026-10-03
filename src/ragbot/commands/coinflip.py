import secrets

from .registry import CommandContext, command


@command("coinflip", "Flip a fair coin: heads or tails")
async def coinflip(ctx: CommandContext):
    # A fresh random bit gives each side exactly the same probability.
    await ctx.reply("heads" if secrets.randbits(1) == 0 else "tails")
