import { createQueueWorker } from "../../../../packages/auth";
import { processAiQueueMessage } from "../../../../packages/domain/consumer";
import { processAiJobsDlqMessage, processWebhookJobsDlqMessage } from "../../../../packages/domain/dlq";
import { WORKFLOWS_MANIFEST } from "./manifest";
import { processWebhookQueueMessage } from "./webhooks";

export default createQueueWorker(WORKFLOWS_MANIFEST, {
  "ai-jobs": processAiQueueMessage,
  "ai-jobs-dlq": processAiJobsDlqMessage,
  "webhook-jobs": processWebhookQueueMessage,
  "webhook-jobs-dlq": processWebhookJobsDlqMessage,
});
