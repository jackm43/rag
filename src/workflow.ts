import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { runChatCompletion, sanitizeAiText } from "./ai";
import { loadConfig } from "./config";
import { postChannelMessage } from "./discord";
import { errorMessage, logger } from "./logger";
import type { AssistantWorkflowParams, Env } from "./types";
import { formatToolResultsForPrompt, webSearch } from "./tools";

const MAX_WORKFLOW_RESPONSE_LENGTH = 1900;

type WorkflowState = {
  status: string;
  resultPreview?: string | null;
  errorMessage?: string | null;
};

const truncate = (value: string, maxLength: number) =>
  value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;

const recordWorkflow = async (
  env: Env,
  instanceId: string,
  params: AssistantWorkflowParams,
  state: WorkflowState,
) => {
  await env.DB.prepare(
    "INSERT INTO assistant_workflows (instance_id, kind, status, channel_id, message_id, requester_user_id, query, result_preview, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(instance_id) DO UPDATE SET status = excluded.status, result_preview = excluded.result_preview, error_message = excluded.error_message, updated_at = CURRENT_TIMESTAMP",
  )
    .bind(
      instanceId,
      params.kind,
      state.status,
      params.channelId,
      params.messageId ?? null,
      params.requesterUserId ?? null,
      params.query,
      state.resultPreview ?? null,
      state.errorMessage ?? null,
    )
    .run();
};

export class AssistantWorkflow extends WorkflowEntrypoint<Env, AssistantWorkflowParams> {
  async run(
    event: Readonly<WorkflowEvent<AssistantWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<unknown> {
    const params = event.payload;

    await step.do("record-start", async () => {
      await recordWorkflow(this.env, event.instanceId, params, { status: "running" });
      return { ok: true };
    });

    try {
      const searchText = await step.do(
        "web-search",
        { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "30 seconds" },
        async () => {
          const results = await webSearch(this.env, params.query);
          return formatToolResultsForPrompt([
            {
              name: "web_search",
              status: "ok",
              content: results.length > 0
                ? results
                  .map((result, index) => {
                    const url = result.url ? ` (${result.url})` : "";
                    return `${index + 1}. ${result.title}${url}: ${result.snippet}`;
                  })
                  .join("\n")
                : `No web search results found for "${params.query}".`,
            },
          ]) ?? "";
        },
      );

      const answer = await step.do("synthesize-answer", async () => {
        const config = await loadConfig(this.env);
        const result = await runChatCompletion(this.env, config, [
          {
            role: "system",
            content: `${config.systemPrompt}\n\nYou are completing a durable background web-search workflow for Discord. Use the provided tool results, include relevant source URLs when present, and keep the answer concise.`,
          },
          {
            role: "user",
            content: `${searchText}\n\nOriginal request from ${params.requesterUsername ?? "user"}:\n${params.prompt}`,
          },
        ]);
        return sanitizeAiText(result.content) || "I finished the search but could not generate a useful summary.";
      });

      const content = truncate(answer, MAX_WORKFLOW_RESPONSE_LENGTH);

      await step.do("post-result", async () => {
        const response = await postChannelMessage(this.env, params.channelId, content);
        if (!response.ok) {
          throw new Error(`Discord post failed (${response.status}): ${await response.text().catch(() => response.statusText)}`);
        }
        return { status: response.status };
      });

      await step.do("record-complete", async () => {
        await recordWorkflow(this.env, event.instanceId, params, {
          status: "complete",
          resultPreview: truncate(content, 500),
        });
        return { ok: true };
      });

      return { ok: true };
    } catch (error) {
      const message = errorMessage(error);
      logger.error("assistant_workflow_failed", { error: message });
      await recordWorkflow(this.env, event.instanceId, params, {
        status: "error",
        errorMessage: message,
      }).catch((recordError) => {
        logger.warn("assistant_workflow_record_failed", { error: errorMessage(recordError) });
      });
      throw error;
    }
  }
}
