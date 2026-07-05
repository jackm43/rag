import { createQueueWorker } from "@rag/service-kit";
import { processSpendQueueMessage } from "@rag/discord/lib/ai/spend";
import { processSpendJobsDlqMessage } from "@rag/discord/lib/domain/dlq";
import { SPEND_MANIFEST } from "./manifest";

export default createQueueWorker(SPEND_MANIFEST, {
  "ai-spend-jobs": processSpendQueueMessage,
  "ai-spend-jobs-dlq": processSpendJobsDlqMessage,
});
