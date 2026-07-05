import { createServiceServer } from "@rag/service-kit";
import { decodeWebhookEventEnvelope } from "@rag/connectors-core/contracts";
import type { Env } from "@rag/discord/contracts";
import { logger } from "@rag/logger";

// Consumer for the webhook-jobs queue: verified third-party webhook events
// enqueued by the webhooks edge worker. The receive pipeline is IDENTICAL to
// ai-jobs (apps/bot/lib/domain/consumer.ts): createServiceServer verifies the
// identity token (iss = webhooks, aud = workflows, envelope-hash binding), the
// registration gate checks webhook.event against the workflows worker's registered
// operations, Cedar authorizes the delivery, and only then is the envelope
// decoded and value-validated. Anything that fails is logged as a denial and
// acked so the queue never wedges on a hostile message.
export const processWebhookQueueMessage = async (message: Message<unknown>, env: Env) => {
  const server = createServiceServer({
    self: "workflows",
    expectedIssuers: ["webhooks"],
    env,
    transportTrust: { queue: "trusted" },
  });
  const received = await server.receive(message.body, decodeWebhookEventEnvelope);
  if (!received) {
    message.ack();
    return;
  }

  const job = received.payload;
  // The structured receipt record: identifiers only — NEVER the body (it may
  // carry third-party payload data that has no business in logs).
  logger.info("webhook_event_received", {
    connectorId: job.connectorId,
    provider: job.provider,
    eventId: job.eventId,
    eventType: job.eventType,
    subject: received.context.subject,
  });

  // SEAM: real webhook processing lands here (dispatch on connectorId/
  // eventType into domain handlers, e.g. reacting to a GitHub push or a
  // Stripe payment event). Receipt-and-ack is deliberate for now: the
  // envelope, verification, dedupe, and this consumer are the durable
  // contract; the handlers are a later feature.
  message.ack();
};
