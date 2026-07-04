import { createQueueWorker } from "@rag/service-kit";
import { processAiQueueMessage } from "../../../lib/domain/consumer";
import { processAiJobsDlqMessage, processWebhookJobsDlqMessage } from "../../../lib/domain/dlq";
import { WORKFLOWS_MANIFEST } from "./manifest";
import { processWebhookQueueMessage } from "./webhooks";

// The per-interaction processor DO. Defined here; the gateway ingress binds it
// cross-script (script_name: ragbot-workflows-worker) to run deferred commands
// where EGRESS + WORKFLOWS_SIGNING_KEY are available.
export { InteractionSession } from "./session";

export default createQueueWorker(WORKFLOWS_MANIFEST, {
  "ai-jobs": processAiQueueMessage,
  "ai-jobs-dlq": processAiJobsDlqMessage,
  "webhook-jobs": processWebhookQueueMessage,
  "webhook-jobs-dlq": processWebhookJobsDlqMessage,
});
