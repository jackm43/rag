import { processSpendQueueMessage } from "../../../../packages/ai/spend";
import type { Env } from "../../../../packages/contracts/types";

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await processSpendQueueMessage(message, env);
    }
  },
};
