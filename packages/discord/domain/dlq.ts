import { decodeAiJobEnvelope, decodeAiSpendJobEnvelope, decodeReplyJobEnvelope } from "../contracts";
import { decodeWebhookEventEnvelope } from "@rag/connectors-core/contracts";
import { logger } from "@rag/logger";

// Dead-letter consumers: a message landing here has exhausted its retries,
// so the job is lost either way — the point is visibility. Log enough to
// investigate (queue name, message id, attempt count, decoded envelope kind)
// but never free-text content, then ack so the DLQ does not grow unbounded.
const logAndAck = (queue: string, message: Message<unknown>, kind: string | undefined) => {
  logger.error("dead_letter_message", {
    queue,
    messageId: message.id,
    attempts: message.attempts,
    kind: kind ?? "undecodable",
  });
  message.ack();
};

// Dead letters carry the plain capnp envelope bytes (producers no longer wrap
// them in a signed service message); decode the kind directly.
const envelopeOf = (message: Message<unknown>) => message.body;

export const processAiJobsDlqMessage = (message: Message<unknown>) =>
  logAndAck("ai-jobs-dlq", message, decodeAiJobEnvelope(envelopeOf(message))?.kind);

export const processSpendJobsDlqMessage = (message: Message<unknown>) =>
  logAndAck("ai-spend-jobs-dlq", message, decodeAiSpendJobEnvelope(envelopeOf(message)) ? "spend" : undefined);

export const processOutboxDlqMessage = (message: Message<unknown>) =>
  logAndAck("discord-outbox-dlq", message, decodeReplyJobEnvelope(envelopeOf(message))?.kind);

export const processWebhookJobsDlqMessage = (message: Message<unknown>) =>
  logAndAck("webhook-jobs-dlq", message, decodeWebhookEventEnvelope(envelopeOf(message))?.kind);
