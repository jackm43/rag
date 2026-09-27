"""Local editor for a fixed production D1 database. Never bundled in production."""

import asyncio
import hashlib
import json
import re
from datetime import datetime, timezone

from ragbot._bundled import FILES
from ragbot.config import SETTINGS_KEY, legacy_snapshot, parse_settings
from ragbot.model_catalog import CreditCatalog, chat_overrides, image_parameters
from ragbot.runtime import env_value, fetch, to_python
from ragbot.settings import DraftNamespace, resolve_config, validate_overrides
from ragbot.settings_storage import READ_SETTINGS, WRITE_SETTINGS

_lock = asyncio.Lock()

READ_HISTORY = """
SELECT id, kind, prompt, response_text, model, status, requester_username, created_at
FROM rag_ai_interactions
WHERE ((? = 'bicture' AND kind = 'bicture')
    OR (? = 'chat' AND kind IN ('ask', 'channel_reply', 'thread_reply')))
  AND (? IS NULL OR id < ?)
  AND (? = '' OR instr(lower(prompt), lower(?)) > 0)
ORDER BY id DESC LIMIT 26
"""


class SettingsError(Exception):
    def __init__(self, message, status=400):
        self.message, self.status = message, status


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


class SettingsEditor:
    def __init__(self, env, target, *, destination=None, transport=fetch, catalog=None):
        if target not in ("local", "live"):
            raise SettingsError("Choose local sandbox or live bot settings.")
        if destination is None:
            from dev_target import TARGET

            destination = TARGET
        self.env, self.target, self.destination = env, target, destination
        self.transport = transport
        self.catalog = catalog or CreditCatalog(env)

    async def remote(self, key):
        # Read-only legacy migration source. New settings never write KV.
        account, namespace = self.destination["account"], self.destination["namespace"]
        if not all(
            re.fullmatch(r"[a-f0-9]{32}", part) for part in (account, namespace)
        ) or key not in (*FILES, SETTINGS_KEY):
            raise SettingsError("Invalid configured settings destination.")
        response = await self.transport(
            f"https://api.cloudflare.com/client/v4/accounts/{account}/storage/kv/namespaces/{namespace}/values/{key}",
            headers={"Authorization": f"Bearer {env_value(self.env, 'CLOUDFLARE_API_TOKEN', '')}"},
        )
        if response.status == 404:
            return None
        if not response.ok:
            raise SettingsError(
                "Cannot read legacy settings. Check the API token's Workers KV Storage permissions.",
                503,
            )
        return await response.text()

    async def query(self, sql, params=()):
        if sql not in (READ_SETTINGS, WRITE_SETTINGS, READ_HISTORY):
            raise SettingsError("Invalid settings query.")
        if self.target == "local":
            statement = self.env.DB.prepare(sql)
            if params:
                statement = statement.bind(*params)
            return to_python(await statement.all())
        account, database = self.destination["account"], self.destination["database"]
        if not re.fullmatch(r"[a-f0-9]{32}", account) or not re.fullmatch(
            r"[a-f0-9-]{36}", database
        ):
            raise SettingsError("Invalid configured settings destination.")
        response = await self.transport(
            f"https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{database}/query",
            method="POST",
            headers={
                "Authorization": f"Bearer {env_value(self.env, 'CLOUDFLARE_API_TOKEN', '')}",
                "content-type": "application/json",
            },
            body=json.dumps({"sql": sql, "params": list(params)}),
        )
        if not response.ok:
            raise SettingsError(
                "Cloudflare could not read or save settings. Check D1 permissions and migrations; reload before retrying.",
                503,
            )
        payload = await response.json()
        results = payload.get("result")
        if (
            not payload.get("success")
            or not isinstance(results, list)
            or len(results) != 1
            or not results[0].get("success")
        ):
            raise SettingsError(
                "D1 did not confirm the operation. Check migrations and reload settings.", 503
            )
        return results[0]

    async def history(self, body):
        page = body.get("page")
        before = body.get("before")
        search = body.get("search", "")
        if (
            page not in ("chat", "bicture")
            or (before is not None and (type(before) is not int or before < 1))
            or not isinstance(search, str)
            or len(search) > 500
        ):
            raise SettingsError("Invalid prompt history filter.")
        rows = (await self.query(READ_HISTORY, (page, page, before, before, search, search)))[
            "results"
        ]
        return {"entries": rows[:25], "next": rows[24]["id"] if len(rows) > 25 else None}

    async def read(self):
        rows = (await self.query(READ_SETTINGS))["results"]
        if rows:
            row = rows[0]
            snapshot = parse_settings(row["document"])
            if snapshot.get("revision") != row["revision"]:
                raise SettingsError("Saved settings revision is invalid.", 409)
            source, storage_revision = "d1", row["revision"]
        else:

            async def get(key):
                return (
                    await self.remote(key)
                    if self.target == "live"
                    else await self.env.AI_CONFIG.get(key)
                )

            snapshot = await legacy_snapshot(get)
            source, storage_revision = "legacy", None
        return await self.describe(snapshot, source, storage_revision)

    async def describe(self, snapshot, source="d1", storage_revision=None):
        return {
            "target": self.target,
            "label": self.destination["worker"] if self.target == "live" else "Local sandbox",
            "revision": snapshot["revision"],
            "storageRevision": storage_revision,
            "source": source,
            "updatedAt": snapshot.get("updatedAt"),
            "resources": snapshot["resources"],
            "config": await resolve_config({}, snapshot["resources"]),
        }

    async def write(self, resources, expected_revision):
        import uuid

        snapshot = {
            "schemaVersion": 1,
            "resources": resources,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
            "revision": uuid.uuid4().hex,
        }
        raw = json.dumps(snapshot)
        parse_settings(raw)
        result = await self.query(WRITE_SETTINGS, (snapshot["revision"], raw, expected_revision))
        if result.get("meta", {}).get("changes") != 1:
            raise SettingsError("Settings changed during your save. Reload and review again.", 409)
        return await self.describe(snapshot, storage_revision=snapshot["revision"])

    async def initialize(self):
        """Operator migration; copy legacy settings only if D1 is still empty."""
        current = await self.read()
        if current["source"] == "d1":
            return current
        return await self.write(current["resources"], None)

    async def prepare(self, body):
        current = await self.read()
        if body.get("baseRevision") != current["revision"]:
            raise SettingsError(
                "Settings changed since you loaded them. Reload and review again.", 409
            )
        overrides = dict(body.get("overrides") or {})
        overrides.pop("chatApiFormat", None)
        overrides.pop("chatTemperatureSupported", None)
        validate_overrides(overrides)
        config = await resolve_config(overrides, current["resources"])
        page = body.get("page")
        if page not in ("chat", "ask", "bicture"):
            raise SettingsError("This command has no editable AI settings.")
        is_image = page == "bicture"
        if any(key.startswith("image") != is_image for key in overrides):
            raise SettingsError("Review settings for one page at a time.")
        available = await self.catalog.validate(
            config, ["image"] if is_image else ["chat", "search"]
        )
        if is_image:
            profile = config["image"]["profiles"][config["image"]["activeProfile"]]
            model = next(m for m in available["image"] if m["id"] == profile["model"])
            overrides["imageParameters"] = image_parameters(model, profile, overrides)
        elif "model" in overrides or "temperature" in overrides:
            selected = next(m for m in available["chat"] if m["id"] == config["responseModel"])
            overrides.update(chat_overrides(selected, config, overrides))
        resources = DraftNamespace(overrides, current["resources"]).values
        changes = [
            {"resource": key, "before": current["resources"][key], "after": value}
            for key, value in resources.items()
            if (
                json.loads(value) != json.loads(current["resources"][key])
                if key.endswith(".json")
                else value != current["resources"][key]
            )
        ]
        return current, resources, changes

    async def preview(self, body):
        current, resources, changes = await self.prepare(body)
        return {
            "changes": changes,
            "reviewId": digest([self.target, current["revision"], resources]),
            "label": current["label"],
        }

    async def save(self, body):
        async with _lock:
            current, resources, changes = await self.prepare(body)
            if body.get("reviewId") != digest([self.target, current["revision"], resources]):
                raise SettingsError("Review these exact settings before saving.", 409)
            if not changes:
                raise SettingsError("There are no changes to save.")
            return await self.write(resources, current["storageRevision"])
