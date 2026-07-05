import { createQueueWorker } from "@rag/queue-kit";
import type { Env } from "@rag/discord/contracts";
import { processSpendQueueMessage } from "@rag/discord/ai/spend";
import { processSpendJobsDlqMessage } from "@rag/discord/domain/dlq";

export default createQueueWorker<Env>("spend", {
  "ai-spend-jobs": processSpendQueueMessage,
  "ai-spend-jobs-dlq": processSpendJobsDlqMessage,
});
