import {
  decodeAiJobEnvelope,
  decodeAiSpendJobEnvelope,
  decodeReplyJobEnvelope,
} from "../contracts";
import { logger } from "../logger";

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

export const processAiJobsDlqMessage = (message: Message<unknown>) =>
  logAndAck("ai-jobs-dlq", message, decodeAiJobEnvelope(message.body)?.kind);

export const processSpendJobsDlqMessage = (message: Message<unknown>) =>
  logAndAck("ai-spend-jobs-dlq", message, decodeAiSpendJobEnvelope(message.body) ? "spend" : undefined);

export const processOutboxDlqMessage = (message: Message<unknown>) =>
  logAndAck("discord-outbox-dlq", message, decodeReplyJobEnvelope(message.body)?.kind);
