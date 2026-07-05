import bictureImageConfig from "../../ai/ai-config/bicture-image.json";
import { buildAiGatewayMetadata } from "../../ai/ai-metadata";
import { errorDetails, errorMessage, logger } from "@rag/logger";
import { boundaryClients } from "@rag/egress/outbound/clients";
import { inferenceClient } from "../../ai/inference";
import { sendInteractionEdit, sendInteractionMediaEdit } from "../outbox";
import { createAiSpendSourceId, recordAiSpendEvent } from "../../ai/spend";
import { type BictureJob, type Env } from "../../../contracts";
import { isRecord } from "@rag/contracts-core";
import type { RequestContext } from "@rag/service-kit/context";
import type { Subject } from "@rag/service-kit";

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

const imageFileFromString = async (env: Env, value: string) => {
  if (/^https:\/\//i.test(value)) {
    const response = await boundaryClients(env, "workflows").mediaDownload(value);
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

const imageFileFrom = async (env: Env, result: unknown) => {
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
    return imageFileFromString(env, imageString);
  }

  throw new Error("missing_bicture_image");
};

const promptSummary = (prompt: string) =>
  prompt.length > MAX_PROMPT_ECHO_LENGTH
    ? `${prompt.slice(0, MAX_PROMPT_ECHO_LENGTH - 1)}...`
    : prompt;

const runBictureImageGeneration = async (
  env: Env,
  prompt: string,
  metadata?: ReturnType<typeof buildAiGatewayMetadata>,
) => {
  return inferenceClient(env).run(
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
};

const buildBictureResponse = async (job: BictureJob & { subject?: Subject }, env: Env) => {
  const spendSourceId = createAiSpendSourceId();
  const result = await runBictureImageGeneration(
    env,
    job.prompt,
    buildAiGatewayMetadata({
      kind: "bicture",
      requestId: spendSourceId,
      requesterUserId: job.requesterUserId,
      channelId: job.channelId,
    }),
  );
  await recordAiSpendEvent(env, {
    kind: "bicture",
    requesterUserId: job.requesterUserId,
    requesterUsername: job.requesterUsername,
    model: activeBictureProfile.model,
    unitCount: 1,
    sourceId: spendSourceId,
    subject: job.subject,
  });
  const imageFile = await imageFileFrom(env, result);
  const filename = filenameForContentType(imageFile.contentType);

  return {
    content: promptSummary(job.prompt),
    file: {
      name: filename,
      contentType: imageFile.contentType,
      data: imageFile.data,
    },
  };
};

const subjectFromContext = (context: RequestContext | undefined, fallback?: string) => context
  ? { sub: context.subject, delegates: context.delegates, requestId: context.requestId, correlationId: context.correlationId }
  : fallback;

export const processBictureJob = async (job: BictureJob, env: Env, context?: RequestContext) => {
  const subject = subjectFromContext(context, job.requesterUserId);
  try {
    const response = await buildBictureResponse(
      { ...job, ...(typeof subject === "object" ? { subject } : {}) },
      env,
    );
    await sendInteractionMediaEdit(env, job.applicationId, job.interactionToken, response.content, response.file, subject);
  } catch (error) {
    logger.error("bicture_command_failed", {
      error: errorMessage(error),
      details: errorDetails(error),
      model: activeBictureProfile.model,
      imageProfile: bictureImageConfig.activeProfile,
      promptLength: job.prompt.length,
    });
    await sendInteractionEdit(
      env,
      job.applicationId,
      job.interactionToken,
      "Could not generate that image. Try a different prompt.",
      subject,
    ).catch(() => undefined);
  }
};
