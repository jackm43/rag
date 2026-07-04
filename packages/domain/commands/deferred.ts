import {
  editOriginalInteractionResponse,
  type InteractionMessageData,
  type InteractionResponseFile,
} from "../../discord";
import { jsonResponse } from "../http";
import { errorMessage, logger } from "../../logger";
import { DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, type DiscordInteraction, type Env } from "../../contracts/types";

type DeferredResult =
  | InteractionMessageData
  | { data: InteractionMessageData; files: InteractionResponseFile[] };

type DeferredOptions = {
  run: () => Promise<DeferredResult>;
  failureMessage: string;
  logEvent: string;
  logContext?: (error: unknown) => Record<string, unknown>;
  onMissingCredentials: () => Response | Promise<Response>;
};

export const handleDeferredInteraction = (
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext,
  options: DeferredOptions,
): Response | Promise<Response> => {
  const applicationId = interaction.application_id;
  const interactionToken = interaction.token;
  if (!applicationId || !interactionToken) {
    return options.onMissingCredentials();
  }

  ctx.waitUntil(
    (async () => {
      try {
        const result = await options.run();
        const { data, files } = "data" in result
          ? result
          : { data: result, files: [] as InteractionResponseFile[] };
        await editOriginalInteractionResponse(env, "workflows", applicationId, interactionToken, data, files);
      } catch (error) {
        logger.error(options.logEvent, {
          error: errorMessage(error),
          ...options.logContext?.(error),
        });
        await editOriginalInteractionResponse(env, "workflows", applicationId, interactionToken, {
          content: options.failureMessage,
          allowed_mentions: { parse: [] },
        }).catch(() => undefined);
      }
    })(),
  );

  return jsonResponse({ type: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
};
