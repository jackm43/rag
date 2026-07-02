import { processAiQueueMessage } from "../../../../packages/domain/consumer";
import { processAiJobsDlqMessage } from "../../../../packages/domain/dlq";
import type { Env } from "../../../../packages/contracts/types";

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    if (batch.queue === "ai-jobs-dlq") {
      for (const message of batch.messages) {
        processAiJobsDlqMessage(message);
      }
      return;
    }

    for (const message of batch.messages) {
      await processAiQueueMessage(message, env);
    }
  },
};
