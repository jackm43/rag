import { WorkerEntrypoint } from "cloudflare:workers";

import { createQueueWorker, ensureRegistered } from "../../../../packages/auth";
import {
  deliverInteractionEdit,
  processOutboxMessage,
} from "../../../../packages/domain/responder";
import { processOutboxDlqMessage } from "../../../../packages/domain/dlq";
import type { Env, ResponderAttachment } from "../../../../packages/contracts/types";
import { RESPONDER_MANIFEST } from "./manifest";

// Service-binding RPC entrypoint for media-bearing interaction edits. Queue
// messages are capped at 128 KiB, so image/audio attachments are handed over
// directly worker-to-worker instead (no network exposure; callable only via
// the binding). A retry would regenerate the media anyway, so losing queue
// durability here costs nothing.
export class Responder extends WorkerEntrypoint<Env> {
  async deliverInteractionEdit(
    envelope: Uint8Array,
    attachment: ResponderAttachment,
    idToken: string,
  ) {
    await ensureRegistered(this.env, RESPONDER_MANIFEST);
    await deliverInteractionEdit(this.env, envelope, idToken, attachment);
  }
}

export default createQueueWorker(RESPONDER_MANIFEST, {
  "discord-outbox": processOutboxMessage,
  "discord-outbox-dlq": processOutboxDlqMessage,
});
