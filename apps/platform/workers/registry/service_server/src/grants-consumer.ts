import type { Env } from "../../../../contracts";
import { isGrantRequest } from "../../../../lib/registry-kit/grants";
import { errorMessage, logger } from "@rag/logger";

// Consumer for the `application-grants` control-plane queue. A trusted producer
// — capability-gated by the queue binding, so only a worker whose wrangler
// declares the producer can enqueue — pushes a GRANT request; this consumer
// resolves the target application's authority DO and hands it the request.
//
// The consumer is deliberately thin: it decodes, validates the request SHAPE,
// dispatches, and acks. The authority DO is the real authorization gate —
// submitGrant() re-verifies the production attestation locally before recording
// any member, so a forged or replayed message grants nothing. Idempotency (the
// claim on the request id) and the durable wait-for-attestation both live in
// the DO (submitGrant/alarm), not here. A malformed message is logged and acked
// so the queue never wedges; only an infrastructure failure (unbound binding,
// RPC error) is retried onto the dead-letter queue.
export const processGrantQueueMessage = async (message: Message<unknown>, env: Env) => {
  const request = message.body;
  if (!isGrantRequest(request)) {
    logger.warn("grant_request_invalid");
    message.ack();
    return;
  }

  const authority = env.APPLICATION_AUTHORITY;
  if (!authority) {
    logger.error("grant_authority_unbound", { appId: request.appId, requestId: request.id });
    message.retry();
    return;
  }

  try {
    const status = await authority.get(authority.idFromName(request.appId)).submitGrant(request);
    logger.info("grant_request_processed", {
      requestId: request.id,
      appId: request.appId,
      client: request.client,
      kind: request.kind,
      status: status.status,
    });
    message.ack();
  } catch (error) {
    logger.warn("grant_request_failed", { requestId: request.id, error: errorMessage(error) });
    message.retry();
  }
};

// The dead-letter drain: a grant request that exhausted its retries. Recorded
// (id only — never the artifact) and acked so the DLQ never wedges; the client
// polling grantStatus(id) sees "unknown" and can re-submit.
export const processGrantDlqMessage = async (message: Message<unknown>, _env: Env) => {
  const body = message.body as { id?: unknown; appId?: unknown } | null;
  logger.error("grant_request_dead_lettered", {
    requestId: typeof body?.id === "string" ? body.id : undefined,
    appId: typeof body?.appId === "string" ? body.appId : undefined,
  });
  message.ack();
};
