import {
  editOriginalInteractionResponse,
  type InteractionMessageData,
  type InteractionResponseFile,
} from "../api";
import { errorMessage, logger } from "@rag/logger";
import type { DiscordInteraction, Env } from "../contracts";

type DeferredResult =
  | InteractionMessageData
  | { data: InteractionMessageData; files: InteractionResponseFile[] };

type DeferredReplyOptions = {
  run: () => Promise<DeferredResult>;
  failureMessage: string;
  logEvent: string;
  logContext?: (error: unknown) => Record<string, unknown>;
};

// Runs a deferred command to completion and edits the original interaction
// response. This runs inside the InteractionSession Durable Object (hosted by
// the workflows worker), which holds the bot token needed for the outbound
// edit. It awaits to completion (the DO owns the lifetime, not a
// fire-and-forget waitUntil); on failure it best-effort posts the failure
// message so the interaction never hangs on "thinking…".
export const runDeferredReply = async (
  interaction: DiscordInteraction,
  env: Env,
  options: DeferredReplyOptions,
): Promise<void> => {
  const applicationId = interaction.application_id;
  const interactionToken = interaction.token;
  if (!applicationId || !interactionToken) {
    logger.error(options.logEvent, { error: "missing_interaction_credentials" });
    return;
  }

  try {
    const result = await options.run();
    const { data, files } = "data" in result
      ? result
      : { data: result, files: [] as InteractionResponseFile[] };
    await editOriginalInteractionResponse(env, applicationId, interactionToken, data, files);
  } catch (error) {
    logger.error(options.logEvent, {
      error: errorMessage(error),
      ...options.logContext?.(error),
    });
    await editOriginalInteractionResponse(env, applicationId, interactionToken, {
      content: options.failureMessage,
      allowed_mentions: { parse: [] },
    }).catch(() => undefined);
  }
};
