import { WorkerEntrypoint } from "cloudflare:workers";

import { createQueueWorker } from "@rag/queue-kit";
import {
  deliverInteractionEdit,
  processOutboxMessage,
} from "@rag/discord/lib/domain/responder";
import { processOutboxDlqMessage } from "@rag/discord/lib/domain/dlq";
import type { Env, ResponderAttachment } from "@rag/discord/contracts";

// Service-binding RPC entrypoint for media-bearing interaction edits. Queue
// messages are capped at 128 KiB, so image/audio attachments are handed over
// directly worker-to-worker instead (callable only via the trusted RESPONDER
// binding). It takes the plain capnp ReplyJob envelope bytes — no signed token.
export class Responder extends WorkerEntrypoint<Env> {
  async deliverInteractionEdit(message: Uint8Array, attachment: ResponderAttachment) {
    await deliverInteractionEdit(this.env, message, attachment);
  }
}

export default createQueueWorker<Env>("responder", {
  "discord-outbox": processOutboxMessage,
  "discord-outbox-dlq": processOutboxDlqMessage,
});
