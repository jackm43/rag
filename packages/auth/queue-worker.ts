import type { ServiceManifest } from "./manifest";
import { ensureRegistered } from "./registry";
import type { Env } from "../contracts/types";
import { logger } from "../logger";

export type QueueMessageHandler = (
  message: Message<unknown>,
  env: Env,
) => void | Promise<void>;

// The shared queue-consumer shell for the service workers (workflows,
// responder, spend). Centralising it makes the shell's two invariants
// unforgeable rather than copied per worker:
// - every batch registers the service manifest before any message is touched
//   (the registration gate the receive pipeline depends on);
// - a queue with no handler is logged and acked, so a consumer misbound in
//   wrangler.jsonc can never wedge a queue on messages it does not understand.
// Handlers own everything past dispatch — verified receive, processing, and
// per-message ack/retry — so each worker is just its manifest plus a routing
// table; anything unique to a worker (e.g. the responder's RPC entrypoint) is
// declared alongside, not inside, this shell.
export const createQueueWorker = (
  manifest: ServiceManifest,
  handlers: Record<string, QueueMessageHandler>,
) => ({
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    // Memoised per isolate and never rejects; a no-op after the first batch.
    await ensureRegistered(env, manifest);

    const handler = handlers[batch.queue];
    if (!handler) {
      logger.warn("queue_without_handler", { service: manifest.service, queue: batch.queue });
      for (const message of batch.messages) {
        message.ack();
      }
      return;
    }

    for (const message of batch.messages) {
      await handler(message, env);
    }
  },
});
