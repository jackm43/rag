import { SlashCommandBuilder } from "../structs/slash-command-builder";

import bictureImageConfig from "../lib/ai/ai-config/bicture-image.json";
import { buildAiGatewayMetadata } from "../lib/ai/ai-metadata";
import { inferenceClient } from "../lib/ai/inference";
import { createAiSpendSourceId, recordAiSpendEvent } from "../lib/ai/spend";
import { fetchMedia } from "../lib/discord";
import { isRecord } from "../lib/contracts";
import { errorDetails, errorMessage, logger } from "../lib/logger";
import { getInvoker, getInvokerDisplayName, stringOption } from "../lib/interaction";
import type { Env } from "../env";
import type { Command } from "../structs/command";

const BICTURE_FILENAME_PREFIX = "bicture";
const DEFAULT_IMAGE_CONTENT_TYPE = "image/jpeg";
const MAX_PROMPT_ECHO_LENGTH = 300;
const DEFAULT_BICTURE_IMAGE_PROFILE = "standard";

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
    const response = await fetchMedia(value);
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
  if (isRecord(result) && typeof result.image === "string" && result.image.length > 0) {
    return result.image;
  }
  if (isRecord(result) && isRecord(result.result) && typeof result.result.image === "string" && result.result.image.length > 0) {
    return result.result.image;
  }
  if (
    isRecord(result) &&
    isRecord(result.result) &&
    isRecord(result.result.result) &&
    typeof result.result.result.image === "string" &&
    result.result.result.image.length > 0
  ) {
    return result.result.result.image;
  }
  if (isRecord(result) && Array.isArray(result.data)) {
    const firstImage = result.data[0];
    if (isRecord(firstImage) && typeof firstImage.b64_json === "string" && firstImage.b64_json.length > 0) {
      return firstImage.b64_json;
    }
    if (isRecord(firstImage) && typeof firstImage.url === "string" && firstImage.url.length > 0) {
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
  prompt.length > MAX_PROMPT_ECHO_LENGTH ? `${prompt.slice(0, MAX_PROMPT_ECHO_LENGTH - 1)}...` : prompt;

const runBictureImageGeneration = async (
  env: Env,
  prompt: string,
  metadata?: ReturnType<typeof buildAiGatewayMetadata>,
) =>
  inferenceClient(env).run(
    activeBictureProfile.model,
    {
      prompt,
      response_format: activeBictureProfile.responseFormat,
      aspect_ratio: activeBictureProfile.aspectRatio,
      quality: activeBictureProfile.quality,
      resolution: activeBictureProfile.resolution,
    },
    { gatewayId: activeBictureProfile.gatewayId, metadata },
  );

const buildBictureResponse = async (
  env: Env,
  prompt: string,
  requesterUserId: string | undefined,
  requesterUsername: string,
  channelId: string | undefined,
) => {
  const spendSourceId = createAiSpendSourceId();
  const result = await runBictureImageGeneration(
    env,
    prompt,
    buildAiGatewayMetadata({
      kind: "bicture",
      requestId: spendSourceId,
      requesterUserId,
      channelId,
    }),
  );
  await recordAiSpendEvent(env, {
    kind: "bicture",
    requesterUserId,
    requesterUsername,
    model: activeBictureProfile.model,
    unitCount: 1,
    sourceId: spendSourceId,
  });
  const imageFile = await imageFileFrom(result);
  const filename = filenameForContentType(imageFile.contentType);

  return {
    content: promptSummary(prompt),
    file: { name: filename, contentType: imageFile.contentType, data: imageFile.data },
  };
};

export const bicture: Command = {
  aiLimited: true,
  data: new SlashCommandBuilder()
    .setName("bicture")
    .setDescription("Generate an image with Cloudflare AI")
    .addStringOption((option) =>
      option
        .setName("prompt")
        .setDescription("Image prompt")
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(2000),
    ),
  async execute({ interaction, env, editReply }) {
    const prompt = stringOption(interaction, "prompt");
    const requester = getInvoker(interaction);
    const requesterUsername = getInvokerDisplayName(interaction);

    try {
      const response = await buildBictureResponse(
        env,
        prompt,
        requester?.id,
        requesterUsername,
        interaction.channel_id,
      );
      await editReply({ content: response.content, files: [response.file] });
    } catch (error) {
      logger.error("bicture_command_failed", {
        error: errorMessage(error),
        details: errorDetails(error),
        model: activeBictureProfile.model,
        imageProfile: bictureImageConfig.activeProfile,
        promptLength: prompt.length,
      });
      await editReply("Could not generate that image. Try a different prompt.").catch(() => undefined);
    }
  },
};
