import { processSpendQueueMessage } from "../../../../packages/ai/spend";
import { processSpendJobsDlqMessage } from "../../../../packages/domain/dlq";
import type { Env } from "../../../../packages/contracts/types";

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    if (batch.queue === "ai-spend-jobs-dlq") {
      for (const message of batch.messages) {
        processSpendJobsDlqMessage(message);
      }
      return;
    }

    for (const message of batch.messages) {
      await processSpendQueueMessage(message, env);
    }
  },
};
