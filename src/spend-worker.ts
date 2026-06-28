import { processSpendQueueMessage } from "./spend";
import type { AiSpendJob, Env } from "./types";

export default {
  async queue(batch: MessageBatch<AiSpendJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      await processSpendQueueMessage(message, env);
    }
  },
};
