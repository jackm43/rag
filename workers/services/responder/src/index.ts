import { WorkerEntrypoint } from "cloudflare:workers";

import {
  deliverInteractionEdit,
  processOutboxMessage,
} from "../../../../packages/domain/responder";
import type { Env, ResponderAttachment } from "../../../../packages/contracts/types";

// Service-binding RPC entrypoint for media-bearing interaction edits. Queue
// messages are capped at 128 KiB, so image/audio attachments are handed over
// directly worker-to-worker instead (no network exposure; callable only via
// the binding). A retry would regenerate the media anyway, so losing queue
// durability here costs nothing.
export class Responder extends WorkerEntrypoint<Env> {
  async deliverInteractionEdit(envelope: Uint8Array, attachment: ResponderAttachment) {
    await deliverInteractionEdit(this.env, envelope, attachment);
  }
}

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await processOutboxMessage(message, env);
    }
  },
};
