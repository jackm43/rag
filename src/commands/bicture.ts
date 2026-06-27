import { editOriginalInteractionResponse } from "../discord";
import { jsonResponse } from "../http";
import { errorMessage, logger } from "../logger";
import {
  CHANNEL_MESSAGE_WITH_SOURCE,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  type DiscordInteraction,
  type Env,
} from "../types";
import { isRecord } from "../validation";

const BICTURE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const BICTURE_FILENAME = "bicture.jpg";
const MAX_PROMPT_ECHO_LENGTH = 300;

const bicturePrompt = (interaction: DiscordInteraction) => {
  const value = interaction.data?.options?.find((option) => option.name === "prompt")?.value;
  return typeof value === "string" ? value.trim() : "";
};

const base64ToBytes = (value: string) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const extractImageBase64 = (result: unknown) => {
  if (isRecord(result) && typeof result.image === "string" && result.image.length > 0) {
    return result.image;
  }
  return null;
};

const promptSummary = (prompt: string) =>
  prompt.length > MAX_PROMPT_ECHO_LENGTH
    ? `${prompt.slice(0, MAX_PROMPT_ECHO_LENGTH - 1)}...`
    : prompt;

const runBictureCommand = async (interaction: DiscordInteraction, env: Env) => {
  const prompt = bicturePrompt(interaction);
  if (!prompt) {
    return {
      data: { content: "An image prompt is required.", allowed_mentions: { parse: [] } },
      files: [],
    };
  }

  const result = await env.AI.run(BICTURE_MODEL, { prompt, steps: 4 });
  const imageBase64 = extractImageBase64(result);
  if (!imageBase64) {
    throw new Error("missing_bicture_image");
  }

  return {
    data: {
      content: `Generated image for: ${promptSummary(prompt)}`,
      allowed_mentions: { parse: [] },
      attachments: [{ id: "0", filename: BICTURE_FILENAME }],
    },
    files: [
      {
        name: BICTURE_FILENAME,
        contentType: "image/jpeg",
        data: base64ToBytes(imageBase64),
      },
    ],
  };
};

export const handleBictureCommand = (
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext,
) => {
  const prompt = bicturePrompt(interaction);
  if (!prompt) {
    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "An image prompt is required.", allowed_mentions: { parse: [] } },
    });
  }

  const applicationId = interaction.application_id;
  const interactionToken = interaction.token;
  if (!applicationId || !interactionToken) {
    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: "Could not defer /bicture without interaction credentials.",
        allowed_mentions: { parse: [] },
      },
    });
  }

  ctx.waitUntil(
    (async () => {
      try {
        const response = await runBictureCommand(interaction, env);
        await editOriginalInteractionResponse(
          applicationId,
          interactionToken,
          response.data,
          response.files,
        );
      } catch (error) {
        logger.error("bicture_command_failed", { error: errorMessage(error) });
        await editOriginalInteractionResponse(applicationId, interactionToken, {
          content: "Could not generate that image. Try a different prompt.",
          allowed_mentions: { parse: [] },
        }).catch(() => undefined);
      }
    })(),
  );

  return jsonResponse({ type: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
};
