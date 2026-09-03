import { SlashCommandBuilder } from "../structs/slash-command-builder";

import ragjamMusicConfig from "../lib/ai/ai-config/ragjam-music.json";
import { buildAiGatewayMetadata } from "../lib/ai/ai-metadata";
import { inferenceClient } from "../lib/ai/inference";
import { createAiSpendSourceId, recordAiSpendEvent } from "../lib/ai/spend";
import { downloadMedia, MediaTooLargeError } from "../lib/discord";
import type { ResponderAttachment } from "../lib/contracts";
import { isRecord } from "../lib/contracts";
import { errorDetails, errorMessage, logger } from "../lib/logger";
import { getInvoker, getInvokerDisplayName, stringOption } from "../lib/interaction";
import type { Env } from "../env";
import type { Command } from "../structs/command";

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
    const media = await downloadMedia(url);
    const contentType = media.contentType ?? DEFAULT_AUDIO_CONTENT_TYPE;
    return { name: filenameForAudio(contentType, url), contentType, data: media.data };
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
) =>
  inferenceClient(env).run(
    activeRagjamConfig.model,
    {
      prompt,
      is_instrumental: activeRagjamConfig.isInstrumental,
      ...(lyrics ? { lyrics } : {}),
      lyrics_optimizer: lyrics ? activeRagjamConfig.lyricsOptimizer : true,
    },
    { gatewayId: activeRagjamConfig.gatewayId, metadata },
  );

const buildRagjamResponse = async (
  env: Env,
  prompt: string,
  lyricsInput: string,
  requesterUserId: string | undefined,
  requesterUsername: string,
  channelId: string | undefined,
) => {
  const lyrics = lyricsInput.trim();
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
      requesterUserId,
      channelId,
    }),
  );
  await recordAiSpendEvent(env, {
    kind: "ragjam",
    requesterUserId,
    requesterUsername,
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

export const ragjam: Command = {
  aiLimited: true,
  data: new SlashCommandBuilder()
    .setName("ragjam")
    .setDescription("Generate a song with Cloudflare AI")
    .addStringOption((option) =>
      option
        .setName("prompt")
        .setDescription("Music style, mood, and scenario")
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(2000),
    )
    .addStringOption((option) =>
      option
        .setName("lyrics")
        .setDescription("Song lyrics; omit to auto-generate lyrics")
        .setRequired(false)
        .setMinLength(1)
        .setMaxLength(3500),
    ),
  async execute({ interaction, env, editReply }) {
    const prompt = stringOption(interaction, "prompt");
    const lyrics = stringOption(interaction, "lyrics");
    const requester = getInvoker(interaction);
    const requesterUsername = getInvokerDisplayName(interaction);

    try {
      const response = await buildRagjamResponse(
        env,
        prompt,
        lyrics,
        requester?.id,
        requesterUsername,
        interaction.channel_id,
      );
      if (response.file) {
        await editReply({ content: response.content, files: [response.file] });
      } else {
        await editReply(response.content);
      }
    } catch (error) {
      logger.error("ragjam_command_failed", {
        error: errorMessage(error),
        details: errorDetails(error),
        model: activeRagjamConfig.model,
        promptLength: prompt.length,
        lyricsLength: lyrics.length,
      });
      await editReply("Could not generate that song. Try a different prompt or lyrics.").catch(() => undefined);
    }
  },
};
