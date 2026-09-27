"""Register the command registry in the bot's guild (run through op run)."""

import json
import os
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
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
                registered = json.load(response)
            expected = {item["name"] for item in payload}
            if {item["name"] for item in registered} != expected:
                raise SystemExit("Discord registration response did not match the registry")
            verify = Request(
                "https://discord.com/api/v10" + path,
                headers={
                    "authorization": f"Bot {token}",
                    "user-agent": "ragbot-worker/1.0",
                },
            )
            with urlopen(verify, timeout=30) as response:
                actual = {item["name"] for item in json.load(response)}
            if actual != expected:
                raise SystemExit("Discord command readback did not match the registry")
            scope = "global" if not payload else "guild"
            print(f"Verified {scope} commands: {', '.join(sorted(actual)) or '(none)'}")
        except HTTPError as error:
            raise SystemExit(f"Discord command registration failed ({error.code})") from None
        except URLError:
            raise SystemExit("Discord command registration network failure") from None
    print(f"Registered {len(COMMANDS)} guild commands.")


if __name__ == "__main__":
    main()
