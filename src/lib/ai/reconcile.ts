import { isRecord } from "../contracts";
import { errorMessage, logger } from "../logger";
import type { Env } from "../../env";

// Ported from packages/discord/ai/spend.ts (processSpendQueueMessage +
// findGatewayLogCostMicros). The collapsed worker has no spend queue, so this
// runs as a batch sweep from scheduled(): pick pending rag_ai_spend_events, look
// up each request's real cost in the AI Gateway logs (Cloudflare API), then write
// estimated_cost_micros and re-derive rag_ai_spend_totals exactly as the old
// consumer did. Rows whose log has not appeared yet stay pending for the next
// sweep. This keeps /ragspend* and the budget guard accurate without queues.

const USD_MICROS = 1_000_000;
const DEFAULT_AIG_GATEWAY_ID = "platy";
const CLOUDFLARE_API_TIMEOUT_MS = 30_000;
// Bounds the per-tick work: at most this many pending events are reconciled each
// cron run (each requires up to 3 paginated log requests).
const RECONCILE_BATCH_SIZE = 25;

type PendingSpendEventRow = {
  source_id: string;
  requester_user_id: string | null;
  requester_username: string | null;
};

const numberFrom = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const parseMetadata = (value: unknown): Record<string, unknown> => {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const costMicrosFrom = (log: unknown) => {
  if (!isRecord(log)) {
    return null;
  }
  const cost = numberFrom(log.cost);
  return cost === null ? null : Math.round(cost * USD_MICROS);
};

const findGatewayLogCostMicros = async (env: Env, sourceId: string) => {
  if (!env.CF_ACCOUNT_ID) {
    throw new Error("CF_ACCOUNT_ID is required to reconcile AI Gateway spend");
  }

  const gatewayId = env.CF_AIG_GATEWAY_ID || DEFAULT_AIG_GATEWAY_ID;
  for (let page = 1; page <= 3; page += 1) {
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai-gateway/gateways/${gatewayId}/logs`,
    );
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", "50");
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
      signal: AbortSignal.timeout(CLOUDFLARE_API_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`AI Gateway logs request failed (${response.status}): ${JSON.stringify(payload)}`);
    }
    const logs = isRecord(payload) && Array.isArray(payload.result) ? payload.result : [];
    for (const log of logs) {
      if (!isRecord(log)) {
        continue;
      }
      const metadata = parseMetadata(log.metadata);
      if (metadata.ragbot_request_id === sourceId) {
        return costMicrosFrom(log);
      }
    }
    if (logs.length < 50) {
      break;
    }
  }
  return null;
};

// Write the reconciled cost and re-derive the user's spend total. Identical SQL
// to the old queue consumer: the event flips pending -> aggregated, then the
// totals row is recomputed from all of that user's aggregated events.
const applyReconciledCost = async (env: Env, event: PendingSpendEventRow, costMicros: number) => {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE rag_ai_spend_events SET estimated_cost_micros = ?, status = 'aggregated', updated_at = CURRENT_TIMESTAMP WHERE source_id = ? AND status != 'aggregated'",
    ).bind(costMicros, event.source_id),
    env.DB.prepare(
      "INSERT INTO rag_ai_spend_totals (requester_user_id, requester_username, estimated_cost_micros, event_count, updated_at) SELECT requester_user_id, COALESCE(?, MAX(requester_username)), COALESCE(SUM(estimated_cost_micros), 0), COUNT(*), CURRENT_TIMESTAMP FROM rag_ai_spend_events WHERE requester_user_id = ? AND status = 'aggregated' GROUP BY requester_user_id ON CONFLICT(requester_user_id) DO UPDATE SET requester_username = COALESCE(excluded.requester_username, rag_ai_spend_totals.requester_username), estimated_cost_micros = excluded.estimated_cost_micros, event_count = excluded.event_count, updated_at = CURRENT_TIMESTAMP",
    ).bind(event.requester_username, event.requester_user_id),
  ]);
};

// One reconciliation sweep. Best-effort: a per-event lookup failure is logged and
// leaves that row pending for the next tick; it never aborts the sweep.
export const reconcileAiSpend = async (env: Env): Promise<{ reconciled: number; scanned: number }> => {
  const pending = await env.DB.prepare(
    "SELECT source_id, requester_user_id, requester_username FROM rag_ai_spend_events WHERE status = 'pending' ORDER BY id ASC LIMIT ?",
  )
    .bind(RECONCILE_BATCH_SIZE)
    .all<PendingSpendEventRow>();

  const rows = pending.results ?? [];
  let reconciled = 0;
  for (const event of rows) {
    let costMicros: number | null = null;
    try {
      costMicros = await findGatewayLogCostMicros(env, event.source_id);
    } catch (error) {
      logger.warn("ai_spend_gateway_log_lookup_failed", { error: errorMessage(error), sourceId: event.source_id });
      continue;
    }

    // No matching log yet — the AI Gateway is eventually consistent, so leave the
    // row pending for a later sweep rather than forcing a zero cost.
    if (costMicros === null) {
      continue;
    }

    try {
      await applyReconciledCost(env, event, costMicros);
      reconciled += 1;
    } catch (error) {
      logger.warn("ai_spend_reconcile_write_failed", { error: errorMessage(error), sourceId: event.source_id });
    }
  }

  return { reconciled, scanned: rows.length };
};
