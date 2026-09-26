"""Register the command registry in the bot's guild (run through op run)."""

import json
import os
import sys
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from ragbot.commands import COMMANDS  # noqa: E402

TARGET_GUILD_ID = "457689460096630794"


def main():
    application_id = os.environ.get("DISCORD_APPLICATION_ID")
    token = os.environ.get("DISCORD_BOT_TOKEN")
    if not application_id or not token:
        raise SystemExit("DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN are required")
    for path, payload in [
        (f"/applications/{application_id}/commands", []),
        (
            f"/applications/{application_id}/guilds/{TARGET_GUILD_ID}/commands",
            [c.data for c in COMMANDS.values()],
        ),
    ]:
        request = Request(
            "https://discord.com/api/v10" + path,
            method="PUT",
            data=json.dumps(payload).encode(),
            headers={
                "authorization": f"Bot {token}",
                "content-type": "application/json",
                "user-agent": "ragbot-worker/1.0",
            },
        )
        try:
            with urlopen(request, timeout=30) as response:
                response.read()
        except HTTPError as error:
            raise SystemExit(f"Discord command registration failed ({error.code})") from None
    print(f"Registered {len(COMMANDS)} guild commands.")


if __name__ == "__main__":
    main()
