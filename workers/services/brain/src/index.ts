import { ensureRegistered } from "../../../../packages/auth";
import { processAiQueueMessage } from "../../../../packages/domain/consumer";
import { processAiJobsDlqMessage } from "../../../../packages/domain/dlq";
import type { Env } from "../../../../packages/contracts/types";
import { BRAIN_MANIFEST } from "./manifest";

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    // Memoised per isolate and never rejects; a no-op after the first batch.
    await ensureRegistered(env, BRAIN_MANIFEST);

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
