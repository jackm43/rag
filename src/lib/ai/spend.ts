import { errorMessage, logger } from "../logger";
import type { Env } from "../../env";

const USD_MICROS = 1_000_000;

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
};

const optionalUsage = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;

const randomEventId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const createAiSpendSourceId = () => `aigreq:${randomEventId()}`;

export const formatUsdMicros = (micros: number) =>
  `$${(Math.max(0, micros) / USD_MICROS).toFixed(2)}`;

// Spend-estimate write path. Inserts the pending spend record straight into D1.
// The old queue-producer hop (SPEND_JOBS.send) and the AI-Gateway log
// reconciliation consumer are gone in the collapsed worker: the estimate row is
// the durable record of a tracked model call.
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
  } catch (error) {
    logger.warn("ai_spend_event_record_failed", { error: errorMessage(error), kind: input.kind, model: input.model });
  }
};
