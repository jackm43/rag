import type { APIChatInputApplicationCommandInteraction } from "discord-api-types/payloads/v10";

import { editOriginalInteractionResponse } from "../discord";
import bictureImageConfig from "../ai-config/bicture-image.json";
import { jsonResponse } from "../http";
import { errorMessage, logger } from "../logger";
import type { Env } from "../types";

const BICTURE_FILENAME_PREFIX = "bicture";
const DEFAULT_IMAGE_CONTENT_TYPE = "image/jpeg";
const MAX_PROMPT_ECHO_LENGTH = 300;
const DEFAULT_BICTURE_IMAGE_PROFILE = "standard";
const DISCORD_RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE = 4;
const DISCORD_RESPONSE_DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5;

type BictureImageProfile = {
  model: string;
  gatewayId: string;
  responseFormat: "url" | "b64_json";
  aspectRatio: string;
  quality: "low" | "medium" | "high";
  resolution: "1k" | "2k";
};

const bictureProfiles = bictureImageConfig.profiles as Record<string, BictureImageProfile>;
const activeBictureProfile =
  bictureProfiles[bictureImageConfig.activeProfile] ?? bictureProfiles[DEFAULT_BICTURE_IMAGE_PROFILE];

if (!activeBictureProfile) {
  throw new Error("No valid /bicture image profile configured");
}

const objectFrom = (value: unknown) =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : null;

const stringOptionValue = (
  interaction: APIChatInputApplicationCommandInteraction,
  name: string,
) => {
  const option = interaction.data?.options?.find((item) => item.name === name);
  return option && "value" in option && typeof option.value === "string" ? option.value : "";
};

const bicturePrompt = (interaction: APIChatInputApplicationCommandInteraction) => {
  return stringOptionValue(interaction, "prompt").trim();
};

const base64ToBytes = (value: string) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const bytesToArrayBuffer = (bytes: Uint8Array) => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const isReadableStream = (value: unknown): value is ReadableStream<Uint8Array> =>
  typeof ReadableStream !== "undefined" && value instanceof ReadableStream;

const extensionForContentType = (contentType: string) => {
  if (contentType.includes("png")) {
    return "png";
  }
  if (contentType.includes("webp")) {
    return "webp";
  }
  return "jpg";
};

const filenameForContentType = (contentType: string) =>
  `${BICTURE_FILENAME_PREFIX}.${extensionForContentType(contentType)}`;

const imageFileFromString = async (value: string) => {
  if (/^https:\/\//i.test(value)) {
    const response = await fetch(value);
    if (!response.ok) {
      throw new Error(`Generated image download failed (${response.status}): ${response.statusText}`);
    }
    return {
      data: await response.arrayBuffer(),
      contentType: response.headers.get("content-type") ?? DEFAULT_IMAGE_CONTENT_TYPE,
    };
  }

  const dataUriMatch = /^data:([^;]+);base64,(.+)$/i.exec(value);
  return {
    data: bytesToArrayBuffer(base64ToBytes(dataUriMatch ? dataUriMatch[2] : value)),
    contentType: dataUriMatch ? dataUriMatch[1] : DEFAULT_IMAGE_CONTENT_TYPE,
  };
};

const extractImageString = (result: unknown) => {
  if (typeof result === "string" && result.length > 0) {
    return result;
  }

  const payload = objectFrom(result);
  if (!payload) {
    return null;
  }

  if (typeof payload.image === "string" && payload.image.length > 0) {
    return payload.image;
  }

  const nestedPayload = objectFrom(payload.result);
  if (nestedPayload && typeof nestedPayload.image === "string" && nestedPayload.image.length > 0) {
    return nestedPayload.image;
  }

  const doubleNestedPayload = objectFrom(nestedPayload?.result);
  if (doubleNestedPayload && typeof doubleNestedPayload.image === "string" && doubleNestedPayload.image.length > 0) {
    return doubleNestedPayload.image;
  }

  if (Array.isArray(payload.data)) {
    const firstImage = objectFrom(payload.data[0]);
    if (firstImage && typeof firstImage.b64_json === "string" && firstImage.b64_json.length > 0) {
      return firstImage.b64_json;
    }
    if (firstImage && typeof firstImage.url === "string" && firstImage.url.length > 0) {
      return firstImage.url;
    }
  }
  return null;
};

const imageFileFrom = async (result: unknown) => {
  if (result instanceof Uint8Array) {
    return { data: bytesToArrayBuffer(result), contentType: DEFAULT_IMAGE_CONTENT_TYPE };
  }
  if (result instanceof ArrayBuffer) {
    return { data: result, contentType: DEFAULT_IMAGE_CONTENT_TYPE };
  }
  if (isReadableStream(result)) {
    return {
      data: await new Response(result).arrayBuffer(),
      contentType: DEFAULT_IMAGE_CONTENT_TYPE,
    };
  }

  const imageString = extractImageString(result);
  if (imageString) {
    return imageFileFromString(imageString);
  }

  throw new Error("missing_bicture_image");
};

const promptSummary = (prompt: string) =>
  prompt.length > MAX_PROMPT_ECHO_LENGTH
    ? `${prompt.slice(0, MAX_PROMPT_ECHO_LENGTH - 1)}...`
    : prompt;

const runBictureImageGeneration = async (env: Env, prompt: string) => {
  return env.AI.run(
    activeBictureProfile.model,
    {
      prompt,
      response_format: activeBictureProfile.responseFormat,
      aspect_ratio: activeBictureProfile.aspectRatio,
      quality: activeBictureProfile.quality,
      resolution: activeBictureProfile.resolution,
    },
    { gateway: { id: activeBictureProfile.gatewayId } } as never,
  );
};

const errorDetails = (error: unknown) => {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }

  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    cause: error.cause instanceof Error ? { name: error.cause.name, message: error.cause.message } : error.cause,
    properties: Object.fromEntries(
      Object.entries(error).filter(([, value]) => typeof value !== "function"),
    ),
  };
};

const runBictureCommand = async (interaction: APIChatInputApplicationCommandInteraction, env: Env) => {
  const prompt = bicturePrompt(interaction);
  if (!prompt) {
    return {
      data: { content: "An image prompt is required.", allowed_mentions: { parse: [] } },
      files: [],
    };
  }

  const result = await runBictureImageGeneration(env, prompt);
  const imageFile = await imageFileFrom(result);
  const filename = filenameForContentType(imageFile.contentType);

  return {
    data: {
      content: promptSummary(prompt),
      allowed_mentions: { parse: [] },
      attachments: [{ id: "0", filename }],
    },
    files: [
      {
        name: filename,
        contentType: imageFile.contentType,
        data: imageFile.data,
      },
    ],
  };
};

export const handleBictureCommand = (
  interaction: APIChatInputApplicationCommandInteraction,
  env: Env,
  ctx: ExecutionContext,
) => {
  const prompt = bicturePrompt(interaction);
  if (!prompt) {
    return jsonResponse({
      type: DISCORD_RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "An image prompt is required.", allowed_mentions: { parse: [] } },
    });
  }

  const applicationId = interaction.application_id;
  const interactionToken = interaction.token;
  if (!applicationId || !interactionToken) {
    return jsonResponse({
      type: DISCORD_RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE,
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
        logger.error("bicture_command_failed", {
          error: errorMessage(error),
          details: errorDetails(error),
          model: activeBictureProfile.model,
          imageProfile: bictureImageConfig.activeProfile,
          promptLength: prompt.length,
        });
        await editOriginalInteractionResponse(applicationId, interactionToken, {
          content: "Could not generate that image. Try a different prompt.",
          allowed_mentions: { parse: [] },
        }).catch(() => undefined);
      }
    })(),
  );

  return jsonResponse({ type: DISCORD_RESPONSE_DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
};
