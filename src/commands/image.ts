import {
  editOriginalInteractionResponse,
  editOriginalInteractionResponseWithFile,
} from "../discord";
import { jsonResponse } from "../http";
import { errorMessage, logger } from "../logger";
import {
  CHANNEL_MESSAGE_WITH_SOURCE,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  type DiscordInteraction,
  type Env,
} from "../types";

const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const IMAGE_CONTENT_TYPE = "image/jpeg";
const IMAGE_FILENAME = "ragbot-image.jpg";
const MAX_PROMPT_LENGTH = 2048;

type FluxImageResult = {
  image?: string;
};

const getPrompt = (interaction: DiscordInteraction) => {
  const value = interaction.data?.options?.find((opt) => opt.name === "prompt")?.value;
  return typeof value === "string" ? value.trim() : "";
};

const promptForMessage = (prompt: string) => {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized.length > 300 ? `${normalized.slice(0, 297)}...` : normalized;
};

const base64ToBytes = (value: string) => {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

const generateImage = async (env: Env, prompt: string) => {
  const result = (await env.AI.run(
    IMAGE_MODEL as never,
    {
      prompt,
      seed: Math.floor(Math.random() * 2_147_483_647),
    } as never,
  )) as FluxImageResult;

  if (!result.image) {
    throw new Error("Image model did not return image bytes");
  }

  return base64ToBytes(result.image);
};

const buildImageCommandResponse = async (
  interaction: DiscordInteraction,
  env: Env,
) => {
  const prompt = getPrompt(interaction);
  if (!prompt) {
    return {
      data: {
        content: "An image prompt is required.",
        allowed_mentions: { parse: [] },
      },
    };
  }

  if (prompt.length > MAX_PROMPT_LENGTH) {
    return {
      data: {
        content: `Image prompts must be ${MAX_PROMPT_LENGTH} characters or fewer.`,
        allowed_mentions: { parse: [] },
      },
    };
  }

  const imageBytes = await generateImage(env, prompt);
  return {
    data: {
      content: `Generated image for: ${promptForMessage(prompt)}`,
      allowed_mentions: { parse: [] },
      attachments: [
        {
          id: 0,
          filename: IMAGE_FILENAME,
          description: promptForMessage(prompt),
        },
      ],
    },
    file: {
      bytes: imageBytes,
      filename: IMAGE_FILENAME,
      contentType: IMAGE_CONTENT_TYPE,
    },
  };
};

export const handleImageCommand = async (interaction: DiscordInteraction, env: Env) => {
  const response = await buildImageCommandResponse(interaction, env);
  return jsonResponse({
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: response.data,
  });
};

export const handleDeferredImageCommand = (
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext,
) => {
  const applicationId = interaction.application_id;
  const interactionToken = interaction.token;
  if (!applicationId || !interactionToken) {
    return handleImageCommand(interaction, env);
  }

  ctx.waitUntil(
    (async () => {
      try {
        const response = await buildImageCommandResponse(interaction, env);
        if (response.file) {
          await editOriginalInteractionResponseWithFile(
            applicationId,
            interactionToken,
            response.data,
            response.file,
          );
          return;
        }
        await editOriginalInteractionResponse(applicationId, interactionToken, response.data);
      } catch (error) {
        logger.error("image_command_failed", { error: errorMessage(error) });
        await editOriginalInteractionResponse(applicationId, interactionToken, {
          content: "Image generation failed. Try again.",
          allowed_mentions: { parse: [] },
        }).catch(() => undefined);
      }
    })(),
  );

  return jsonResponse({ type: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
};
