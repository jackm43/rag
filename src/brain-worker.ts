import { processAiQueueMessage } from "./consumer";
import type { Env } from "./types";

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await processAiQueueMessage(message, env);
    }
  },
};
