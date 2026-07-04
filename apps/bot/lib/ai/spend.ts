import { decodeAiSpendJobEnvelope, encodeAiSpendJobEnvelope } from "../../contracts";
import { errorMessage, logger } from "@rag/logger";
import { boundaryClients } from "@rag/egress/outbound/clients";
import { createClient, createServiceServer, SYSTEM_SUBJECT, type Subject, type VerifiedRequestContext } from "@rag/service-kit";
import type { Env } from "../../contracts";
import { isRecord } from "@rag/contracts-core";

const USD_MICROS = 1_000_000;
const DEFAULT_AIG_GATEWAY_ID = "platy";

type SpendEventInput = {
  kind: string;
  requesterUserId?: string | null;
  requesterUsername?: string | null;
  model: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  unitCount?: number;
  sourceId?: string;
  subject?: Subject;
};

type SpendEventRow = {
  source_id: string;
  kind: string;
  requester_user_id: string | null;
  requester_username: string | null;
  model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  unit_count: number;
  estimated_cost_micros: number | null;
  status: string;
};

const clientContextOf = (subject: Subject | undefined, fallback: string | undefined): VerifiedRequestContext =>
  subject
    ? {
        subject: subject.sub,
        delegates: subject.delegates,
        requestId: subject.requestId,
        correlationId: subject.correlationId,
      }
    : { subject: fallback ?? SYSTEM_SUBJECT };

const optionalUsage = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;

const randomEventId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const createAiSpendSourceId = () => `aigreq:${randomEventId()}`;

export const formatUsdMicros = (micros: number) =>
  `$${(Math.max(0, micros) / USD_MICROS).toFixed(2)}`;

export const recordAiSpendEvent = async (env: Env, input: SpendEventInput) => {
  if (!input.requesterUserId) {
    return;
  }

  const sourceId = input.sourceId ?? createAiSpendSourceId();
  try {
    await env.DB.prepare(
      "INSERT INTO rag_ai_spend_events (source_id, kind, requester_user_id, requester_username, model, prompt_tokens, completion_tokens, total_tokens, unit_count, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)",
    )
      .bind(
        sourceId,
        input.kind,
        input.requesterUserId,
        input.requesterUsername ?? null,
        input.model,
        optionalUsage(input.promptTokens),
        optionalUsage(input.completionTokens),
        optionalUsage(input.totalTokens),
        Math.max(0, Math.floor(input.unitCount ?? 0)),
      )
      .run();

    if (env.SPEND_JOBS) {
      // Spend reconciliation is a workflows-originated flow: it re-mints an
      // on-behalf-of token for the original requester when known, else the
      // user-less "system" subject.
      await createClient({
        env,
        self: "workflows",
        context: clientContextOf(input.subject, input.requesterUserId),
      }).to("spend", { transportTrust: "trusted" }).call({
        transport: "queue",
        queue: env.SPEND_JOBS,
        envelope: encodeAiSpendJobEnvelope({ spendEventId: sourceId }, { source: "worker" }),
        delaySeconds: 120,
      });
    }
  } catch (error) {
    logger.warn("ai_spend_event_record_failed", { error: errorMessage(error), kind: input.kind, model: input.model });
  }
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
    const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai-gateway/gateways/${gatewayId}/logs`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", "50");
    const response = await boundaryClients(env, "spend").cloudflareApi(url);
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

export const processSpendQueueMessage = async (message: Message<unknown>, env: Env) => {
  const server = createServiceServer({
    self: "spend",
    expectedIssuers: ["workflows"],
    env,
    transportTrust: { queue: "trusted" },
  });
  const received = await server.receive(message.body, decodeAiSpendJobEnvelope);
  if (!received) {
    message.ack();
    return;
  }
  const job = received.payload;

  const event = await env.DB.prepare(
    "SELECT source_id, kind, requester_user_id, requester_username, model, prompt_tokens, completion_tokens, total_tokens, unit_count, estimated_cost_micros, status FROM rag_ai_spend_events WHERE source_id = ?",
  )
    .bind(job.spendEventId)
    .first<SpendEventRow>();

  if (!event || event.status === "aggregated") {
    message.ack();
    return;
  }

  let costMicros: number | null = null;
  try {
    costMicros = await findGatewayLogCostMicros(env, event.source_id);
  } catch (error) {
    logger.warn("ai_spend_gateway_log_lookup_failed", { error: errorMessage(error), sourceId: event.source_id });
  }

  if (costMicros === null) {
    if (message.attempts < 5) {
      message.retry({ delaySeconds: 120 });
    } else {
      logger.warn("ai_spend_gateway_log_unmatched", { sourceId: event.source_id });
      message.ack();
    }
    return;
  }

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE rag_ai_spend_events SET estimated_cost_micros = ?, status = 'aggregated', updated_at = CURRENT_TIMESTAMP WHERE source_id = ? AND status != 'aggregated'",
    ).bind(costMicros, event.source_id),
    env.DB.prepare(
      "INSERT INTO rag_ai_spend_totals (requester_user_id, requester_username, estimated_cost_micros, event_count, updated_at) SELECT requester_user_id, COALESCE(?, MAX(requester_username)), COALESCE(SUM(estimated_cost_micros), 0), COUNT(*), CURRENT_TIMESTAMP FROM rag_ai_spend_events WHERE requester_user_id = ? AND status = 'aggregated' GROUP BY requester_user_id ON CONFLICT(requester_user_id) DO UPDATE SET requester_username = COALESCE(excluded.requester_username, rag_ai_spend_totals.requester_username), estimated_cost_micros = excluded.estimated_cost_micros, event_count = excluded.event_count, updated_at = CURRENT_TIMESTAMP",
    ).bind(event.requester_username, event.requester_user_id),
  ]);

  message.ack();
};
