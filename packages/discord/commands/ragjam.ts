import ragjamMusicConfig from "../ai/ai-config/ragjam-music.json";
import { buildAiGatewayMetadata } from "../ai/ai-metadata";
import { errorDetails, errorMessage, logger } from "@rag/logger";
import { fetchMedia, MediaTooLargeError } from "../api/http";
import { inferenceClient } from "../ai/inference";
import { sendInteractionEdit, sendInteractionMediaEdit } from "../domain/outbox";
import { createAiSpendSourceId, recordAiSpendEvent } from "../ai/spend";
import { type Env, type RagjamJob, type ResponderAttachment } from "../contracts";
import { isRecord } from "@rag/contracts-core";

const DISCORD_MESSAGE_HARD_LIMIT = 2000;
const RAGJAM_FILENAME_PREFIX = "ragjam";
const DEFAULT_AUDIO_CONTENT_TYPE = "audio/mpeg";

type RagjamMusicConfig = {
  model: string;
  gatewayId: string;
  isInstrumental: boolean;
  lyricsOptimizer: boolean;
};

const activeRagjamConfig = ragjamMusicConfig as RagjamMusicConfig;

const promptContent = (prompt: string, prefix: string) => {
  const available = DISCORD_MESSAGE_HARD_LIMIT - prefix.length;
  if (prompt.length <= available) {
    return `${prefix}${prompt}`;
  }
  return `${prefix}${prompt.slice(0, Math.max(0, available - 3))}...`;
};

const extractAudioUrl = (result: unknown): string | null => {
  if (isRecord(result) && typeof result.audio === "string" && result.audio.length > 0) {
    return result.audio;
  }
  if (isRecord(result) && isRecord(result.result) && typeof result.result.audio === "string" && result.result.audio.length > 0) {
    return result.result.audio;
  }
  if (
    isRecord(result) &&
    isRecord(result.result) &&
    isRecord(result.result.result) &&
    typeof result.result.result.audio === "string" &&
    result.result.result.audio.length > 0
  ) {
    return result.result.result.audio;
  }
  return null;
};

const extensionForAudio = (contentType: string, url: string) => {
  if (contentType.includes("wav") || /\.wav(?:$|[?#])/i.test(url)) {
    return "wav";
  }
  return "mp3";
};

const filenameForAudio = (contentType: string, url: string) =>
  `${RAGJAM_FILENAME_PREFIX}.${extensionForAudio(contentType, url)}`;

const audioFileFromUrl = async (url: string): Promise<ResponderAttachment | null> => {
  try {
    const response = await fetchMedia(url);
    if (!response.ok) {
      throw new Error(`Generated audio download failed (${response.status}): ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") ?? DEFAULT_AUDIO_CONTENT_TYPE;
    return {
      name: filenameForAudio(contentType, url),
      contentType,
      data: await response.arrayBuffer(),
    };
  } catch (error) {
    if (error instanceof MediaTooLargeError) {
      return null;
    }
    throw error;
  }
};

const runRagjamMusicGeneration = async (
  env: Env,
  prompt: string,
  lyrics: string | null,
  metadata?: ReturnType<typeof buildAiGatewayMetadata>,
) => {
  return inferenceClient(env).run(
    activeRagjamConfig.model,
    {
      prompt,
      is_instrumental: activeRagjamConfig.isInstrumental,
      ...(lyrics ? { lyrics } : {}),
      lyrics_optimizer: lyrics ? activeRagjamConfig.lyricsOptimizer : true,
    },
    { gatewayId: activeRagjamConfig.gatewayId, metadata },
  );
};

const buildRagjamResponse = async (job: RagjamJob, env: Env) => {
  const { prompt } = job;
  const lyrics = job.lyrics?.trim() || "";
  if (!prompt) {
    return { content: "A music prompt is required.", file: null };
  }

  const spendSourceId = createAiSpendSourceId();
  const result = await runRagjamMusicGeneration(
    env,
    prompt,
    lyrics || null,
    buildAiGatewayMetadata({
      kind: "ragjam",
      requestId: spendSourceId,
      requesterUserId: job.requesterUserId,
      channelId: job.channelId,
    }),
  );
  await recordAiSpendEvent(env, {
    kind: "ragjam",
    requesterUserId: job.requesterUserId,
    requesterUsername: job.requesterUsername,
    model: activeRagjamConfig.model,
    unitCount: 1,
    sourceId: spendSourceId,
  });

  const audioUrl = extractAudioUrl(result);
  if (!audioUrl) {
    throw new Error("missing_ragjam_audio");
  }

  let audioFile: ResponderAttachment | null = null;
  try {
    audioFile = await audioFileFromUrl(audioUrl);
  } catch (error) {
    logger.warn("ragjam_audio_download_failed", {
      error: errorMessage(error),
      audioHost: URL.canParse(audioUrl) ? new URL(audioUrl).hostname : "invalid",
    });
  }

  if (audioFile) {
    return { content: promptContent(prompt, "Prompt: "), file: audioFile };
  }

  return { content: promptContent(prompt, `Generated song: ${audioUrl}\nPrompt: `), file: null };
};

export const processRagjamJob = async (job: RagjamJob, env: Env) => {
  try {
    const response = await buildRagjamResponse(job, env);
    if (response.file) {
      await sendInteractionMediaEdit(env, job.applicationId, job.interactionToken, response.content, response.file);
    } else {
      await sendInteractionEdit(env, job.applicationId, job.interactionToken, response.content);
    }
  } catch (error) {
    logger.error("ragjam_command_failed", {
      error: errorMessage(error),
      details: errorDetails(error),
      model: activeRagjamConfig.model,
      promptLength: job.prompt.length,
      lyricsLength: job.lyrics?.length ?? 0,
    });
    await sendInteractionEdit(
      env,
      job.applicationId,
      job.interactionToken,
      "Could not generate that song. Try a different prompt or lyrics.",
    ).catch(() => undefined);
  }
};
