"""Initialize an empty D1 settings row from operator files.

Existing D1 settings are always preserved. Use --check to verify without writes.
Live commands require op run --env-file=.env --.
"""

import argparse
import asyncio
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace

import pyjson5
from stage_worker import ROOT, command

sys.path[:0] = [str(ROOT / "src"), str(ROOT / "dev")]
from settings_api import SettingsEditor, SettingsError  # noqa: E402
from settings_seed import load_resources  # noqa: E402

from ragbot.settings_storage import READ_SETTINGS, WRITE_SETTINGS  # noqa: E402


async def transport(url, **options):
    request = urllib.request.Request(
        url,
        data=options.get("body", "").encode() if "body" in options else None,
        method=options.get("method", "GET"),
        headers={**options.get("headers", {}), "User-Agent": "ragbot-settings-init/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            status, raw = response.status, response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        status, raw = error.code, ""

    async def text():
        return raw

    async def payload():
        return json.loads(raw)

    return SimpleNamespace(ok=200 <= status < 300, status=status, text=text, json=payload)


class LocalEditor(SettingsEditor):
    def __init__(self, config_path, persist_to):
        super().__init__(SimpleNamespace(), "local", destination={"worker": "Local sandbox"})
        self.config_path, self.persist_to = config_path, persist_to

    async def query(self, sql, params=()):
        # Only this initialization tool renders SQL literals into a temporary file.
        # Production and the UI keep using bound D1 parameters.
        parts = sql.split("?")
        if len(parts) != len(params) + 1:
            raise ValueError("invalid initialization query")
        statement = parts[0]
        for value, part in zip(params, parts[1:]):
            statement += "NULL" if value is None else "'" + str(value).replace("'", "''") + "'"
            statement += part
        if sql == WRITE_SETTINGS:
            # Wrangler's CLI omits the binding's meta.changes field.
            statement += "; SELECT changes() AS changes;"
        with tempfile.TemporaryDirectory(prefix="ragbot-settings-") as directory:
            path = Path(directory) / "settings.sql"
            path.write_text(statement, encoding="utf-8")
            result = subprocess.run(
                command(
                    "pnpm",
                    "exec",
                    "wrangler",
                    "d1",
                    "execute",
                    "ragbot",
                    "--local",
                    "--config",
                    str(self.config_path),
                    "--persist-to",
                    str(self.persist_to),
                    "--file",
                    str(path),
                    "--json",
                ),
                cwd=ROOT,
                check=True,
                capture_output=True,
                encoding="utf-8",
                env=dict(os.environ, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV="false"),
            )
        payload = json.loads(result.stdout)
        expected = 2 if sql == WRITE_SETTINGS else 1
        if len(payload) != expected or not all(item.get("success") for item in payload):
            raise SettingsError("D1 did not confirm initialization.", 503)
        if sql == WRITE_SETTINGS:
            payload[0]["meta"]["changes"] = payload[1]["results"][0]["changes"]
        return payload[0]


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local", action="store_true")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--persist-to", default=".wrangler/state")
    args = parser.parse_args()
    config_path = ROOT / "wrangler.jsonc"
    config = pyjson5.loads(config_path.read_text())
    if args.local:
        editor = LocalEditor(config_path, ROOT / args.persist_to)
    else:
        target = {
            "worker": config["name"],
            "account": config["vars"]["CF_ACCOUNT_ID"],
            "database": next(
                b["database_id"] for b in config["d1_databases"] if b["binding"] == "DB"
            ),
        }
        editor = SettingsEditor(
            SimpleNamespace(CLOUDFLARE_API_TOKEN=os.environ["CLOUDFLARE_API_TOKEN"]),
            "live",
            destination=target,
            transport=transport,
        )
    rows = (await editor.query(READ_SETTINGS))["results"]
    if rows or args.check:
        verified = await editor.read()
        already_initialized = True
    else:
        resources = load_resources()
        saved = await editor.write(resources, None)
        verified = await editor.read()
        assert resources == verified["resources"] and saved["revision"] == verified["revision"]
        already_initialized = False
    print(
        json.dumps(
            {
                "source": verified["source"],
                "revision": verified["revision"],
                "alreadyInitialized": already_initialized,
                "valuesPreserved": True,
            }
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
