"""Copy current live KV settings into D1 once, without changing their values.

Run after D1 migrations, before deploying the runtime reader:
  op run --env-file=.env -- uv run python scripts/migrate_ai_settings.py
"""

import asyncio
import json
import os
import sys
import urllib.error
import urllib.request
from types import SimpleNamespace

import pyjson5
from stage_worker import ROOT

sys.path[:0] = [str(ROOT / "src"), str(ROOT / "dev")]
from settings_api import SettingsEditor  # noqa: E402


async def transport(url, **options):
    request = urllib.request.Request(
        url,
        data=options.get("body", "").encode() if "body" in options else None,
        method=options.get("method", "GET"),
        headers={**options.get("headers", {}), "User-Agent": "ragbot-settings-migration/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            status, raw = response.status, response.read().decode()
    except urllib.error.HTTPError as error:
        status, raw = error.code, ""

    async def text():
        return raw

    async def payload():
        return json.loads(raw)

    return SimpleNamespace(ok=200 <= status < 300, status=status, text=text, json=payload)


async def main():
    config = pyjson5.loads((ROOT / "wrangler.jsonc").read_text())
    target = {
        "worker": config["name"],
        "account": config["vars"]["CF_ACCOUNT_ID"],
        "database": next(b["database_id"] for b in config["d1_databases"] if b["binding"] == "DB"),
        "namespace": next(b["id"] for b in config["kv_namespaces"] if b["binding"] == "AI_CONFIG"),
    }
    editor = SettingsEditor(
        SimpleNamespace(CLOUDFLARE_API_TOKEN=os.environ["CLOUDFLARE_API_TOKEN"]),
        "live",
        destination=target,
        transport=transport,
    )
    before = await editor.read()
    result = await editor.initialize()
    verified = await editor.read()
    assert before["resources"] == result["resources"] == verified["resources"]
    assert result["revision"] == verified["revision"]
    print(
        json.dumps(
            {
                "source": verified["source"],
                "revision": verified["revision"],
                "valuesPreserved": True,
                "alreadyMigrated": before["source"] == "d1",
            }
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
