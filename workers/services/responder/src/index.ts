import { WorkerEntrypoint } from "cloudflare:workers";

import {
  deliverInteractionEdit,
  processOutboxMessage,
} from "../../../../packages/domain/responder";
import { processOutboxDlqMessage } from "../../../../packages/domain/dlq";
import type { Env, ResponderAttachment } from "../../../../packages/contracts/types";

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
    await deliverInteractionEdit(this.env, envelope, idToken, attachment);
  }
}

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    if (batch.queue === "discord-outbox-dlq") {
      for (const message of batch.messages) {
        processOutboxDlqMessage(message);
      }
      return;
    }

    for (const message of batch.messages) {
      await processOutboxMessage(message, env);
    }
  },
};
