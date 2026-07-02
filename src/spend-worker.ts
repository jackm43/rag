import { processSpendQueueMessage } from "./spend";
import type { Env } from "./types";

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await processSpendQueueMessage(message, env);
    }
  },
};
