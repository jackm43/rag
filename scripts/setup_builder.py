"""Configure/provision the builder using operator-supplied environment values.

Invoke through op run; no secret values are written to configuration files.
"""

import argparse
import json
import os
import re
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

import pyjson5

ROOT = Path(__file__).resolve().parents[1]


def run(args, *, cwd=ROOT, data=None):
    subprocess.run(args, cwd=cwd, input=data, text=True, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply", action="store_true", help="Provision and deploy configured resources"
    )
    args = parser.parse_args()
    required = [
        "BUILDER_APP_DOMAIN",
        "BUILDER_ZONE_NAME",
        "DISCORD_APPLICATION_ID",
        "GITHUB_REPOSITORY",
    ]
    values = {key: os.environ.get(key, "") for key in required}
    missing = [key for key, value in values.items() if not value]
    if missing:
        raise SystemExit("Supply these setup values: " + ", ".join(missing))
    domain, zone = values["BUILDER_APP_DOMAIN"], values["BUILDER_ZONE_NAME"]
    if not re.fullmatch(r"[a-z0-9.-]+", domain) or not (
        domain == zone or domain.endswith("." + zone)
    ):
        raise SystemExit("App domain must be a hostname inside the configured Cloudflare zone.")
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", values["GITHUB_REPOSITORY"]):
        raise SystemExit("GITHUB_REPOSITORY must be owner/repository.")
    config = pyjson5.loads((ROOT / "builder/wrangler.jsonc").read_text())
    config["vars"].update(
        APP_DOMAIN=domain,
        AUTH_ORIGIN=f"https://login.{domain}",
        DISCORD_CLIENT_ID=values["DISCORD_APPLICATION_ID"],
        GITHUB_REPOSITORY=values["GITHUB_REPOSITORY"],
        GITHUB_BASE_BRANCH=os.environ.get("GITHUB_BASE_BRANCH", "main"),
    )
    config["routes"] = [{"pattern": f"*.{domain}/*", "zone_name": zone}]
    bot = pyjson5.loads((ROOT / "wrangler.jsonc").read_text())
    config["vars"]["ALLOWED_GUILD_IDS"] = bot["vars"]["ALLOWED_GUILD_IDS"]
    config["account_id"] = bot["vars"]["CF_ACCOUNT_ID"]
    print(f"Discord OAuth redirect: https://login.{domain}/_auth/callback")
    print(f"Requires proxied wildcard DNS and a TLS certificate covering *.{domain}.")
    if not args.apply:
        print("Configuration validated. Use --apply under op run to provision and deploy.")
        return
    secrets = ["OPENAI_API_KEY", "DISCORD_CLIENT_SECRET", "DISCORD_BOT_TOKEN", "GITHUB_TOKEN"]
    if any(not os.environ.get(key) for key in [*secrets, "CLOUDFLARE_API_TOKEN"]):
        raise SystemExit("Supply builder secrets and CLOUDFLARE_API_TOKEN through op run.")
    # Only non-secret settings are persisted.
    (ROOT / "builder/wrangler.jsonc").write_text(json.dumps(config, indent=2) + "\n")
    account = config["account_id"]
    base = f"https://api.cloudflare.com/client/v4/accounts/{account}/r2/buckets"
    headers = {
        "Authorization": "Bearer " + os.environ["CLOUDFLARE_API_TOKEN"],
        "Content-Type": "application/json",
    }
    try:
        with urllib.request.urlopen(urllib.request.Request(base, headers=headers)) as response:
            buckets = json.load(response)["result"]["buckets"]
        name = config["r2_buckets"][0]["bucket_name"]
        if not any(bucket["name"] == name for bucket in buckets):
            with urllib.request.urlopen(
                urllib.request.Request(
                    base, headers=headers, method="POST", data=json.dumps({"name": name}).encode()
                )
            ) as response:
                if not json.load(response).get("success"):
                    raise SystemExit("R2 provisioning failed.")
    except urllib.error.URLError:
        raise SystemExit("Cloudflare provisioning failed; check account permissions.") from None
    run(["pnpm", "install", "--frozen-lockfile"], cwd=ROOT / "builder")
    run(["pnpm", "run", "deploy"], cwd=ROOT / "builder")
    run(
        ["pnpm", "exec", "wrangler", "secret", "bulk"],
        cwd=ROOT / "builder",
        data=json.dumps({key: os.environ[key] for key in secrets}),
    )
    # Deploy backward-compatible readers before extending the live settings snapshot.
    bot["vars"]["BUILDER_ENABLED"] = "false"
    (ROOT / "wrangler.jsonc").write_text(json.dumps(bot, indent=2) + "\n")
    run(["pnpm", "run", "deploy"])
    run(["pnpm", "run", "d1:migrate:remote"])
    bot["vars"]["BUILDER_ENABLED"] = "true"
    (ROOT / "wrangler.jsonc").write_text(json.dumps(bot, indent=2) + "\n")
    run(["pnpm", "run", "types"])
    run(["pnpm", "run", "deploy"])
    print(
        "Builder and bot deployed. Register Discord commands with the documented registration command."
    )


if __name__ == "__main__":
    main()
