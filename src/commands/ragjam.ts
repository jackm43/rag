import { commandData } from "../structs/command-data";

import activeRagjamConfig from "../lib/ai/ai-config/ragjam-music.json";
import { downloadMedia, MediaTooLargeError } from "../lib/discord";
import type { ResponderAttachment } from "../lib/contracts";
import { mediaResultString } from "../lib/ai/media-result";
import { errorDetails, errorMessage, logger } from "../lib/logger";
import { generateMedia } from "../lib/ai/media-generation";
import { stringOption } from "../lib/interaction";
import type { Command } from "../structs/command";

const DISCORD_MESSAGE_HARD_LIMIT = 2000;
const DEFAULT_AUDIO_CONTENT_TYPE = "audio/mpeg";

const promptContent = (prompt: string, prefix: string) => {
  const available = DISCORD_MESSAGE_HARD_LIMIT - prefix.length;
  if (prompt.length <= available) {
    return `${prefix}${prompt}`;
  }
  return `${prefix}${prompt.slice(0, Math.max(0, available - 3))}...`;
};

const extensionForAudio = (contentType: string, url: string) => {
  if (contentType.includes("wav") || /\.wav(?:$|[?#])/i.test(url)) {
    return "wav";
  }
  return "mp3";
};

const filenameForAudio = (contentType: string, url: string) =>
  `ragjam.${extensionForAudio(contentType, url)}`;

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

export const ragjam: Command = {
  aiLimited: true,
  data: commandData("ragjam", "Generate a song with Cloudflare AI", [
    { type: 3, name: "prompt", description: "Music style, mood, and scenario", required: true, min_length: 1, max_length: 2000 },
    { type: 3, name: "lyrics", description: "Song lyrics; omit to auto-generate lyrics", required: false, min_length: 1, max_length: 3500 },
  ]),
  async execute(context) {
    const { interaction, editReply } = context;
    const prompt = stringOption(interaction, "prompt");
    const lyricsInput = stringOption(interaction, "lyrics");
    const lyrics = lyricsInput.trim();
    try {
      if (!prompt) {
        await editReply("A music prompt is required.");
        return;
      }
      const result = await generateMedia(context, "ragjam", activeRagjamConfig, {
        prompt, is_instrumental: activeRagjamConfig.isInstrumental,
        ...(lyrics ? { lyrics } : {}), lyrics_optimizer: lyrics ? activeRagjamConfig.lyricsOptimizer : true,
      });
      const audioUrl = mediaResultString(result, "audio");
      if (!audioUrl) throw new Error("missing_ragjam_audio");
      const file = await audioFileFromUrl(audioUrl).catch((error) => {
        logger.warn("ragjam_audio_download_failed", {
          error: errorMessage(error), audioHost: URL.canParse(audioUrl) ? new URL(audioUrl).hostname : "invalid",
        });
        return null;
      });
      await editReply(file
        ? { content: promptContent(prompt, "Prompt: "), files: [file] }
        : promptContent(prompt, `Generated song: ${audioUrl}\nPrompt: `));
    } catch (error) {
      logger.error("ragjam_command_failed", {
        error: errorMessage(error), details: errorDetails(error), model: activeRagjamConfig.model,
        promptLength: prompt.length, lyricsLength: lyricsInput.length,
      });
      await editReply("Could not generate that song. Try a different prompt or lyrics.").catch(() => undefined);
    }
  },
};
