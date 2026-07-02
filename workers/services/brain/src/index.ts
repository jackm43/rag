import { processAiQueueMessage } from "../../../../packages/domain/consumer";
import type { Env } from "../../../../packages/contracts/types";

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await processAiQueueMessage(message, env);
    }
  },
};
