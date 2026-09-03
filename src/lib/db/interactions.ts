import { errorMessage, logger } from "../logger";
import type { Env } from "../../env";

export type AiInteractionRecord = {
  kind: string;
  channelId: string;
  messageId?: string | null;
  requesterUserId?: string | null;
  requesterUsername?: string | null;
  prompt: string;
  model: string;
  status: "ok" | "error";
  // The exact text delivered to Discord (post egress policy), or null on failure.
  responseText: string | null;
  errorMessage: string | null;
  aiDurationMs: number | null;
  totalDurationMs: number;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
};

// Best-effort analytics write shared by every AI reply path (/ask, mentions,
// thread replies). A failed insert is logged and never bubbles.
export const recordAiInteraction = async (env: Env, record: AiInteractionRecord) => {
  try {
    await env.DB.prepare(
      "INSERT INTO rag_ai_interactions (kind, channel_id, message_id, requester_user_id, requester_username, prompt, response_text, model, ai_duration_ms, total_duration_ms, status, error_message, prompt_tokens, completion_tokens, total_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        record.kind,
        record.channelId,
        record.messageId ?? null,
        record.requesterUserId ?? null,
        record.requesterUsername ?? null,
        record.prompt,
        record.responseText,
        record.model,
        record.aiDurationMs,
        record.totalDurationMs,
        record.status,
        record.errorMessage,
        record.usage?.promptTokens ?? null,
        record.usage?.completionTokens ?? null,
        record.usage?.totalTokens ?? null,
      )
      .run();
  } catch (error) {
    logger.warn("interaction_record_failed", { error: errorMessage(error) });
  }
};
