import { decodeWebhookEventEnvelope } from "@rag/discord/contracts";
import type { Env } from "@rag/discord/contracts";
import { logger } from "@rag/logger";

// Consumer for the webhook-jobs queue: third-party webhook events enqueued by the
// webhooks edge worker (which verified the provider signature broker-side before
// enqueueing). The event crosses the trusted webhooks -> workflows queue as a
// plain capnp envelope — no token to verify. The envelope is decoded and
// value-validated; anything that fails is acked so the queue never wedges.
export const processWebhookQueueMessage = async (message: Message<unknown>, env: Env) => {
  const job = decodeWebhookEventEnvelope(message.body);
  if (!job) {
    message.ack();
    return;
  }

  // The structured receipt record: identifiers only — NEVER the body (it may
  // carry third-party payload data that has no business in logs).
  logger.info("webhook_event_received", {
    connectorId: job.connectorId,
    provider: job.provider,
    eventId: job.eventId,
    eventType: job.eventType,
  });

  // SEAM: real webhook processing lands here (dispatch on connectorId/
  // eventType into domain handlers, e.g. reacting to a GitHub push or a
  // Stripe payment event). Receipt-and-ack is deliberate for now: the
  // envelope, verification, dedupe, and this consumer are the durable
  // contract; the handlers are a later feature.
  message.ack();
};
