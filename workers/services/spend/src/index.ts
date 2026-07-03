import { ensureRegistered } from "../../../../packages/auth";
import { processSpendQueueMessage } from "../../../../packages/ai/spend";
import { processSpendJobsDlqMessage } from "../../../../packages/domain/dlq";
import type { Env } from "../../../../packages/contracts/types";
import { SPEND_MANIFEST } from "./manifest";

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    // Memoised per isolate and never rejects; a no-op after the first batch.
    await ensureRegistered(env, SPEND_MANIFEST);

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
