import { createQueueWorker } from "@rag/queue-kit";
import type { Env } from "@rag/discord/contracts";
import { processAiQueueMessage } from "@rag/discord/domain/consumer";
import { processAiJobsDlqMessage, processWebhookJobsDlqMessage } from "@rag/discord/domain/dlq";
import { processWebhookQueueMessage } from "./webhooks";

// The per-interaction processor DO. Defined here; the gateway ingress binds it
// cross-script (script_name: ragbot-workflows-worker) to run deferred commands
// where EGRESS is available.
export { InteractionSession } from "./session";

export default createQueueWorker<Env>("workflows", {
  "ai-jobs": processAiQueueMessage,
  "ai-jobs-dlq": processAiJobsDlqMessage,
  "webhook-jobs": processWebhookQueueMessage,
  "webhook-jobs-dlq": processWebhookJobsDlqMessage,
});
