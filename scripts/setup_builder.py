"""Provision and deploy the app builder. Run under op run so secrets stay in
the environment: nothing is written to disk.

    op run --env-file=.env --env-file=.env.builder -- uv run python scripts/setup_builder.py
"""

import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "builder"
SECRETS = ("DISCORD_CLIENT_SECRET", "CF_AIG_TOKEN")


def wrangler(*args, data=None, check=True):
    return subprocess.run(
        ["pnpm", "exec", "wrangler", *args],
        cwd=BUILDER,
        input=data,
        text=True,
        check=check,
        capture_output=data is None and not check,
    )


def main():
    missing = [key for key in (*SECRETS, "CLOUDFLARE_API_TOKEN") if not os.environ.get(key)]
    if missing:
        raise SystemExit("Supply through op run: " + ", ".join(missing))
    subprocess.run(["pnpm", "install", "--frozen-lockfile"], cwd=BUILDER, check=True)
    created = wrangler("r2", "bucket", "create", "ragbot-build-artifacts", check=False)
    if created.returncode and "already exists" not in (created.stdout + created.stderr):
        raise SystemExit("Could not create the R2 bucket; check the API token's R2 permission.")
    wrangler("deploy")
    wrangler("secret", "bulk", data=json.dumps({key: os.environ[key] for key in SECRETS}))
    print(
        "Builder deployed. Next: add the OAuth redirect in Discord, apply D1 migrations, "
        "set BUILDER_ENABLED to true and deploy the bot (docs/discord-builder-setup.md)."
    )


if __name__ == "__main__":
    main()
