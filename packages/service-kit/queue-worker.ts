import type { ServiceManifest } from "./manifest";
import { ensureRegistered } from "./registry";
import type { ServiceKitEnv as Env } from "./env";
import { errorMessage, logger } from "@rag/logger";

export type QueueMessageHandler<TEnv extends Env = Env> = (
  message: Message<unknown>,
  env: TEnv,
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
export const createQueueWorker = <TEnv extends Env>(
  manifest: ServiceManifest,
  handlers: Record<string, QueueMessageHandler<TEnv>>,
) => ({
  async queue(batch: MessageBatch<unknown>, env: TEnv): Promise<void> {
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

    // Handlers own per-message ack/retry on their own paths. This catch is only
    // a contract backstop: a handler that *throws* is a bug, and letting it
    // propagate would fail every sibling message in the batch and reprocess the
    // whole batch on retry. Isolate the fault to its own message instead —
    // retry() so it is redelivered (and eventually dead-lettered), never
    // silently dropped. A throw after the handler already ack'd/retried is a
    // no-op here, since the first disposition wins.
    for (const message of batch.messages) {
      try {
        await handler(message, env);
      } catch (error) {
        logger.error("queue_handler_threw", {
          service: manifest.service,
          queue: batch.queue,
          error: errorMessage(error),
        });
        message.retry();
      }
    }
  },
});
