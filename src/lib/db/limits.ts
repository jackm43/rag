import { errorMessage, logger } from "../logger";
import type { Env } from "../../env";

const DEFAULT_AI_BURST_LIMIT_PER_MINUTE = 8;
const DEFAULT_AI_GLOBAL_DAILY_BUDGET_USD = 10;
const USD_MICROS = 1_000_000;

export type AiUsageDecision =
  | { allowed: true }
  | { allowed: false; reason: "rate_limited" | "budget_exceeded"; message: string };

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parsePositiveFloat = (value: string | undefined, fallback: number) => {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// Pre-flight guard for every AI-invoking path, tuned for attacker abuse
// rather than heavy legitimate use: a per-user burst limit catches floods
// and scripted spam, and a global trailing-24h budget across all users is
// the wallet backstop if any account is compromised. Spend events with a
// NULL estimated_cost_micros count as zero, so the budget is deliberately
// best-effort. On D1 errors the guard fails open: availability wins over
// enforcement for this bot.
export const checkAiUsageAllowed = async (
  env: Env,
  userId: string | undefined,
  kind: string,
): Promise<AiUsageDecision> => {
  if (!userId) {
    return { allowed: true };
  }

  const burstLimitPerMinute = parsePositiveInt(
    env.AI_BURST_LIMIT_PER_MINUTE,
    DEFAULT_AI_BURST_LIMIT_PER_MINUTE,
  );
  const globalDailyBudgetMicros = Math.round(
    parsePositiveFloat(env.AI_GLOBAL_DAILY_BUDGET_USD, DEFAULT_AI_GLOBAL_DAILY_BUDGET_USD) *
      USD_MICROS,
  );

  try {
    // Both reads in one D1 round trip; the request is logged only if allowed.
    const [requestResult, spendResult] = await env.DB.batch<{ request_count?: number; spend_micros?: number }>([
      env.DB.prepare(
        "SELECT COUNT(*) AS request_count FROM rag_ai_requests WHERE requester_user_id = ? AND created_at >= datetime('now', '-1 minute')",
      ).bind(userId),
      env.DB.prepare(
        "SELECT COALESCE(SUM(estimated_cost_micros), 0) AS spend_micros FROM rag_ai_spend_events WHERE created_at >= datetime('now', '-24 hours')",
      ),
    ]);
    const requestRow = requestResult.results?.[0];
    const requestCount = typeof requestRow?.request_count === "number" ? requestRow.request_count : 0;
    if (requestCount >= burstLimitPerMinute) {
      return {
        allowed: false,
        reason: "rate_limited",
        message: "Slow down a little — try again in a minute.",
      };
    }

    const spendRow = spendResult.results?.[0];
    const spendMicros = typeof spendRow?.spend_micros === "number" ? spendRow.spend_micros : 0;
    if (spendMicros >= globalDailyBudgetMicros) {
      return {
        allowed: false,
        reason: "budget_exceeded",
        message: "The server's daily AI budget is spent. Try again tomorrow.",
      };
    }

    await env.DB.prepare("INSERT INTO rag_ai_requests (requester_user_id, kind) VALUES (?, ?)")
      .bind(userId, kind)
      .run();
  } catch (error) {
    logger.warn("ai_usage_check_failed", { error: errorMessage(error), kind });
  }

  return { allowed: true };
};

// The burst guard only ever looks one minute back, so the request log is
// garbage after that. Run from the cron trigger; best-effort.
export const pruneAiRequestLog = async (env: Env) => {
  try {
    await env.DB.prepare("DELETE FROM rag_ai_requests WHERE created_at < datetime('now', '-1 day')").run();
  } catch (error) {
    logger.warn("ai_request_log_prune_failed", { error: errorMessage(error) });
  }
};
