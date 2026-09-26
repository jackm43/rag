"""Bounded, idempotent reconciliation of AI Gateway costs into D1."""

import json
import logging
import math

from .runtime import env_value

log = logging.getLogger("ragbot")


def parse_metadata(value) -> dict:
    if isinstance(value, dict):
        return value
    try:
        parsed = json.loads(value)
        return parsed if isinstance(parsed, dict) else {}
    except TypeError, ValueError:
        return {}


async def reconcile_spend(app) -> dict:
    rows = await app.db.all(
        "SELECT source_id, requester_user_id, requester_username FROM rag_ai_spend_events WHERE status = 'pending' ORDER BY id ASC LIMIT ?",
        25,
    )
    if not rows:
        return {"reconciled": 0, "scanned": 0}
    costs: dict[str, int | None] = {}
    try:
        account = app.env.CF_ACCOUNT_ID
        if not account:
            raise ValueError("CF_ACCOUNT_ID is required")
        gateway = env_value(app.env, "CF_AIG_GATEWAY_ID") or "platy"
        for page in range(1, 4):
            response = await app.transport(
                f"https://api.cloudflare.com/client/v4/accounts/{account}/ai-gateway/gateways/{gateway}/logs?page={page}&per_page=50",
                timeout_ms=30000,
                headers={"authorization": f"Bearer {app.env.CLOUDFLARE_API_TOKEN}"},
            )
            if not response.ok:
                raise RuntimeError(f"AI Gateway logs request failed ({response.status})")
            payload = await response.json()
            logs = payload.get("result", []) if isinstance(payload, dict) else []
            for item in logs:
                if not isinstance(item, dict):
                    continue
                request_id = parse_metadata(item.get("metadata")).get("ragbot_request_id")
                if not isinstance(request_id, str) or request_id in costs:
                    continue
                try:
                    raw = item.get("cost")
                    cost = (
                        float(raw)
                        if isinstance(raw, (int, float, str)) and not isinstance(raw, bool)
                        else math.nan
                    )
                    costs[request_id] = (
                        math.floor(cost * 1_000_000 + 0.5) if math.isfinite(cost) else None
                    )
                except ValueError, TypeError:
                    costs[request_id] = None
            if len(logs) < 50:
                break
    except Exception:
        log.warning("ai_spend_gateway_log_lookup_failed")
        return {"reconciled": 0, "scanned": len(rows)}
    reconciled = 0
    for event in rows:
        cost_micros = costs.get(event["source_id"])
        if cost_micros is None:
            continue
        try:
            await app.db.batch(
                [
                    (
                        "UPDATE rag_ai_spend_events SET estimated_cost_micros = ?, status = 'aggregated', updated_at = CURRENT_TIMESTAMP WHERE source_id = ? AND status != 'aggregated'",
                        (cost_micros, event["source_id"]),
                    ),
                    (
                        "INSERT INTO rag_ai_spend_totals (requester_user_id, requester_username, estimated_cost_micros, event_count, updated_at) SELECT requester_user_id, COALESCE(?, MAX(requester_username)), COALESCE(SUM(estimated_cost_micros), 0), COUNT(*), CURRENT_TIMESTAMP FROM rag_ai_spend_events WHERE requester_user_id = ? AND status = 'aggregated' GROUP BY requester_user_id ON CONFLICT(requester_user_id) DO UPDATE SET requester_username = COALESCE(excluded.requester_username, rag_ai_spend_totals.requester_username), estimated_cost_micros = excluded.estimated_cost_micros, event_count = excluded.event_count, updated_at = CURRENT_TIMESTAMP",
                        (event["requester_username"], event["requester_user_id"]),
                    ),
                ]
            )
            reconciled += 1
        except Exception:
            log.warning("ai_spend_reconcile_write_failed")
    return {"reconciled": reconciled, "scanned": len(rows)}
