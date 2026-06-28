import ragjamMusicConfig from "../ai-config/ragjam-music.json";
import { buildAiGatewayMetadata } from "../ai-metadata";
import { editOriginalInteractionResponse, type InteractionResponseFile } from "../discord";
import { jsonResponse } from "../http";
import { errorMessage, logger } from "../logger";
import { createAiSpendSourceId, recordAiSpendEvent } from "../spend";
import {
  CHANNEL_MESSAGE_WITH_SOURCE,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  type DiscordInteraction,
  type Env,
  type RagjamJob,
} from "../types";
import { isRecord } from "../validation";

const MAX_DISCORD_MESSAGE_LENGTH = 2000;
const RAGJAM_FILENAME_PREFIX = "ragjam";
const DEFAULT_AUDIO_CONTENT_TYPE = "audio/mpeg";
const MAX_DISCORD_AUDIO_UPLOAD_BYTES = 25 * 1024 * 1024;

type RagjamMusicConfig = {
  model: string;
  gatewayId: string;
  isInstrumental: boolean;
  lyricsOptimizer: boolean;
};

const activeRagjamConfig = ragjamMusicConfig as RagjamMusicConfig;

const stringOption = (interaction: DiscordInteraction, name: string) => {
  const value = interaction.data?.options?.find((option) => option.name === name)?.value;
  return typeof value === "string" ? value.trim() : "";
};

const ragjamPrompt = (interaction: DiscordInteraction) => stringOption(interaction, "prompt");

const ragjamLyrics = (interaction: DiscordInteraction) => stringOption(interaction, "lyrics");

const promptContent = (prompt: string, prefix: string) => {
  const available = MAX_DISCORD_MESSAGE_LENGTH - prefix.length;
  if (prompt.length <= available) {
    return `${prefix}${prompt}`;
  }
  return `${prefix}${prompt.slice(0, Math.max(0, available - 3))}...`;
};

const requesterUsernameFrom = (interaction: DiscordInteraction) =>
  interaction.member?.nick?.trim() ||
  interaction.member?.user?.global_name?.trim() ||
  interaction.user?.global_name?.trim() ||
  interaction.member?.user?.username?.trim() ||
  interaction.user?.username?.trim() ||
  "user";

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

const audioFileFromUrl = async (url: string): Promise<InteractionResponseFile | null> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Generated audio download failed (${response.status}): ${response.statusText}`);
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_DISCORD_AUDIO_UPLOAD_BYTES) {
    return null;
  }

  const contentType = response.headers.get("content-type") ?? DEFAULT_AUDIO_CONTENT_TYPE;
  const data = await response.arrayBuffer();
  if (data.byteLength > MAX_DISCORD_AUDIO_UPLOAD_BYTES) {
    return null;
  }

  return {
    name: filenameForAudio(contentType, url),
    contentType,
    data,
  };
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

const runRagjamMusicGeneration = async (
  env: Env,
  prompt: string,
  lyrics: string | null,
  metadata?: ReturnType<typeof buildAiGatewayMetadata>,
) => {
  return env.AI.run(
    activeRagjamConfig.model,
    {
      prompt,
      is_instrumental: activeRagjamConfig.isInstrumental,
      ...(lyrics ? { lyrics } : {}),
      lyrics_optimizer: lyrics ? activeRagjamConfig.lyricsOptimizer : true,
    },
    { gateway: { id: activeRagjamConfig.gatewayId, metadata } } as never,
  );
};

const buildRagjamResponse = async (job: RagjamJob, env: Env) => {
  const { prompt } = job;
  const lyrics = job.lyrics?.trim() || "";
  if (!prompt) {
    return {
      data: { content: "A music prompt is required.", allowed_mentions: { parse: [] } },
      files: [],
    };
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

  let audioFile: InteractionResponseFile | null = null;
  try {
    audioFile = await audioFileFromUrl(audioUrl);
  } catch (error) {
    logger.warn("ragjam_audio_download_failed", { error: errorMessage(error), audioUrl });
  }

  if (audioFile) {
    return {
      data: {
        content: promptContent(prompt, "Prompt: "),
        allowed_mentions: { parse: [] },
        attachments: [{ id: "0", filename: audioFile.name }],
      },
      files: [audioFile],
    };
  }

  return {
    data: {
      content: promptContent(prompt, `Generated song: ${audioUrl}\nPrompt: `),
      allowed_mentions: { parse: [] },
    },
    files: [],
  };
};

export const processRagjamJob = async (job: RagjamJob, env: Env) => {
  try {
    const response = await buildRagjamResponse(job, env);
    await editOriginalInteractionResponse(job.applicationId, job.interactionToken, response.data, response.files);
  } catch (error) {
    logger.error("ragjam_command_failed", {
      error: errorMessage(error),
      details: errorDetails(error),
      model: activeRagjamConfig.model,
      promptLength: job.prompt.length,
      lyricsLength: job.lyrics?.length ?? 0,
    });
    await editOriginalInteractionResponse(job.applicationId, job.interactionToken, {
      content: "Could not generate that song. Try a different prompt or lyrics.",
      allowed_mentions: { parse: [] },
    }).catch(() => undefined);
  }
};

export const handleRagjamCommand = async (
  interaction: DiscordInteraction,
  env: Env,
) => {
  const prompt = ragjamPrompt(interaction);
  const lyrics = ragjamLyrics(interaction);
  if (!prompt) {
    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "A music prompt is required.", allowed_mentions: { parse: [] } },
    });
  }

  const applicationId = interaction.application_id;
  const interactionToken = interaction.token;
  if (!applicationId || !interactionToken) {
    return jsonResponse({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: "Could not defer /ragjam without interaction credentials.",
        allowed_mentions: { parse: [] },
      },
    });
  }

  const requester = interaction.member?.user ?? interaction.user;
  await env.AI_JOBS.send({
    kind: "ragjam",
    applicationId,
    interactionToken,
    channelId: interaction.channel_id,
    requesterUserId: requester?.id,
    requesterUsername: requesterUsernameFrom(interaction),
    prompt,
    ...(lyrics ? { lyrics } : {}),
  });

  return jsonResponse({ type: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
};
