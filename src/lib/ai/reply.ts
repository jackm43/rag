import type { Env } from "../../env";
import type { ChatModelResult } from "./ai";
import { loadConfig, type BotConfig } from "./config";
import { recordAiInteraction, type AiInteractionRecord } from "../db/interactions";
import { finalizeAiReplyText, postChannelMessage } from "../discord";
import { errorMessage, logger } from "../logger";

type ReplyContext = Pick<AiInteractionRecord,
  "kind" | "channelId" | "messageId" | "requesterUserId" | "requesterUsername" | "prompt">;

// Record exactly the final text sent to Discord, including failed delivery.
export const deliverAiReply = async (
  env: Env,
  context: ReplyContext,
  complete: (config: BotConfig, startAi: () => void) => Promise<{ result: ChatModelResult; responseText: string }>,
  startedAt = Date.now(),
): Promise<boolean> => {
  const record: AiInteractionRecord = {
    ...context, model: "unknown", status: "ok", responseText: null, errorMessage: null,
    aiDurationMs: null, totalDurationMs: 0, usage: null,
  };
  try {
    const config = await loadConfig(env);
    record.model = config.responseModel;
    let aiStartedAt = Date.now();
    const { result, responseText } = await complete(config, () => { aiStartedAt = Date.now(); });
    record.model = result.model;
    record.usage = result.usage ?? null;
    record.aiDurationMs = Date.now() - aiStartedAt;
    record.responseText = finalizeAiReplyText(responseText);
    const posted = await postChannelMessage(env, context.channelId, record.responseText);
    if (!posted.ok) throw new Error(`discord_channel_post_failed_${posted.status}`);
  } catch (error) {
    record.status = "error";
    record.errorMessage = errorMessage(error);
    logger.error("ai_job_failed", { error: record.errorMessage });
  }
  record.totalDurationMs = Date.now() - startedAt;
  await recordAiInteraction(env, record);
  return record.status === "ok";
};
