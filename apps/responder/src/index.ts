import { WorkerEntrypoint } from "cloudflare:workers";

import { createQueueWorker, ensureRegistered } from "@rag/service-kit";
import {
  deliverInteractionEdit,
  processOutboxMessage,
} from "@rag/discord/lib/domain/responder";
import { processOutboxDlqMessage } from "@rag/discord/lib/domain/dlq";
import type { Env, ResponderAttachment } from "@rag/discord/contracts";
import type { ServiceMessageBytes } from "@rag/contracts-core";
import { RESPONDER_MANIFEST } from "./manifest";

// Service-binding RPC entrypoint for media-bearing interaction edits. Queue
// messages are capped at 128 KiB, so image/audio attachments are handed over
// directly worker-to-worker instead (no network exposure; callable only via
// the binding). A retry would regenerate the media anyway, so losing queue
// durability here costs nothing.
export class Responder extends WorkerEntrypoint<Env> {
  async deliverInteractionEdit(
    message: ServiceMessageBytes,
    attachment: ResponderAttachment,
  ) {
    await ensureRegistered(this.env, RESPONDER_MANIFEST);
    await deliverInteractionEdit(this.env, message, attachment);
  }
}

export default createQueueWorker(RESPONDER_MANIFEST, {
  "discord-outbox": processOutboxMessage,
  "discord-outbox-dlq": processOutboxDlqMessage,
});
