import { commandData } from "../structs/command-data";

import bictureImageConfig from "../lib/ai/ai-config/bicture-image.json";
import { downloadMedia } from "../lib/discord";
import { mediaResultString } from "../lib/ai/media-result";
import { isRecord } from "../lib/contracts";
import { errorDetails, errorMessage, logger } from "../lib/logger";
import { generateMedia } from "../lib/ai/media-generation";
import { stringOption } from "../lib/interaction";
import type { Command } from "../structs/command";

const DEFAULT_IMAGE_CONTENT_TYPE = "image/jpeg";
const MAX_PROMPT_ECHO_LENGTH = 300;

const bictureProfiles: Record<string, (typeof bictureImageConfig.profiles)[keyof typeof bictureImageConfig.profiles]> =
  bictureImageConfig.profiles;
const activeBictureProfile =
  bictureProfiles[bictureImageConfig.activeProfile] ?? bictureProfiles.standard;

if (!activeBictureProfile) {
  throw new Error("No valid /bicture image profile configured");
}

const base64ToBytes = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

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
  `bicture.${extensionForContentType(contentType)}`;

const imageFileFromString = async (value: string) => {
  if (/^https:\/\//i.test(value)) {
    const media = await downloadMedia(value);
    return { data: media.data, contentType: media.contentType ?? DEFAULT_IMAGE_CONTENT_TYPE };
  }

  const dataUriMatch = /^data:([^;]+);base64,(.+)$/i.exec(value);
  return {
    data: base64ToBytes(dataUriMatch ? dataUriMatch[2] : value),
    contentType: dataUriMatch ? dataUriMatch[1] : DEFAULT_IMAGE_CONTENT_TYPE,
  };
};

const extractImageString = (result: unknown) => {
  if (typeof result === "string" && result.length > 0) {
    return result;
  }
  const image = mediaResultString(result, "image");
  if (image) return image;
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

const imageFileFrom = async (result: unknown): Promise<{ data: BlobPart; contentType: string }> => {
  if (result instanceof ArrayBuffer) {
    return { data: result, contentType: DEFAULT_IMAGE_CONTENT_TYPE };
  }
  if (result instanceof Uint8Array) {
    // Re-wrap so the view is guaranteed to sit on a plain ArrayBuffer.
    return { data: new Uint8Array(result), contentType: DEFAULT_IMAGE_CONTENT_TYPE };
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

export const bicture: Command = {
  aiLimited: true,
  data: commandData("bicture", "Generate an image with Cloudflare AI", [
    { type: 3, name: "prompt", description: "Image prompt", required: true, min_length: 1, max_length: 2000 },
  ]),
  async execute(context) {
    const { interaction, editReply } = context;
    const prompt = stringOption(interaction, "prompt");
    try {
      const profile = activeBictureProfile;
      const result = await generateMedia(context, "bicture", profile, {
        prompt, response_format: profile.responseFormat, aspect_ratio: profile.aspectRatio,
        quality: profile.quality, resolution: profile.resolution,
      });
      const file = await imageFileFrom(result);
      await editReply({ content: promptSummary(prompt), files: [{ ...file, name: filenameForContentType(file.contentType) }] });
    } catch (error) {
      logger.error("bicture_command_failed", {
        error: errorMessage(error), details: errorDetails(error), model: activeBictureProfile.model,
        imageProfile: bictureImageConfig.activeProfile, promptLength: prompt.length,
      });
      await editReply("Could not generate that image. Try a different prompt.").catch(() => undefined);
    }
  },
};
