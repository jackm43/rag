import { errorMessage, logger } from "@rag/logger";

// The shared queue-consumer shell, signing-free. A worker is its routing table;
// the shell owns two invariants:
//   - a queue with no handler is logged and acked, so a consumer misbound in
//     wrangler.jsonc can never wedge a queue on messages it does not understand;
//   - a handler that throws is isolated to its own message and retried, never
//     failing the whole batch.
// Handlers own everything past dispatch — decode, process, per-message ack/retry.
// Queue payloads are still capnp `EventEnvelope` bytes (JSON mangles Uint8Array);
// what's gone is the signed `ServiceMessage` wrapper — messages cross trusted
// producer/consumer bindings, so the producer capability authenticates them.

export type QueueMessageHandler<Env> = (
  message: Message<unknown>,
  env: Env,
) => void | Promise<void>;

export const createQueueWorker = <Env>(
  service: string,
  handlers: Record<string, QueueMessageHandler<Env>>,
): Pick<ExportedHandler<Env>, "queue"> => ({
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const handler = handlers[batch.queue];
    if (!handler) {
      logger.warn("queue_without_handler", { service, queue: batch.queue });
      for (const message of batch.messages) {
        message.ack();
      }
      return;
    }

    for (const message of batch.messages) {
      try {
        await handler(message, env);
      } catch (error) {
        logger.error("queue_handler_threw", {
          service,
          queue: batch.queue,
          error: errorMessage(error),
        });
        message.retry();
      }
    }
  },
});
