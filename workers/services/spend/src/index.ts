import { createQueueWorker } from "../../../../packages/auth";
import { processSpendQueueMessage } from "../../../../packages/ai/spend";
import { processSpendJobsDlqMessage } from "../../../../packages/domain/dlq";
import { SPEND_MANIFEST } from "./manifest";

export default createQueueWorker(SPEND_MANIFEST, {
  "ai-spend-jobs": processSpendQueueMessage,
  "ai-spend-jobs-dlq": processSpendJobsDlqMessage,
});
