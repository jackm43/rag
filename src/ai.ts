// Ragbot's model calls through the AI binding: chat with the picture tool, and /bicture images.
import type { Env } from "./index.ts";
import type { AiInteraction } from "./data.ts";
import { chatRequest, chatResponse, imageOutput, rejectsSampling, tokenUsage, type Tool } from "./lib/ai.ts";
import type { Attachment } from "./lib/discord/messages.ts";
import { truncate } from "./lib/discord/rest.ts";
import { readMedia } from "./lib/media.ts";
import type { Settings } from "./settings.ts";

/** Run a model, tagging AI Gateway logs (at most five metadata entries) with who asked. */
export async function runModel(
  env: Env,
  model: string,
  inputs: Record<string, unknown>,
  gatewayId: string | undefined,
  record: AiInteraction,
  revision: string,
): Promise<any> {
  const attribution = record.source;
  record.model = model;
  record.revision = revision;
  const metadata = {
    ragbot_kind: record.kind,
    discord_user_id: attribution.userId,
    discord_channel_id: attribution.channelId,
    discord_message_id: attribution.messageId,
    ragbot_settings_revision: revision,
  };
  const started = Date.now();
  try {
    const result = await (gatewayId ? env.AI.run(model, inputs, { gateway: { id: gatewayId, metadata } }) : env.AI.run(model, inputs));
    record.usage = tokenUsage(result);
    if (typeof result?.model === "string" && result.model) record.model = result.model;
    return result;
  } finally {
    record.aiDurationMs = Date.now() - started;
  }
}

/** Lets a chat model post a generated picture instead of only text. */
export const PICTURE_TOOL: Tool = {
  name: "create_picture",
  description:
    "Generate an image and post it with your reply. Call it only when the latest message explicitly asks you to make, draw, show or picture something. Never call it for greetings, chat or questions. If you are unsure, do not call it.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Only a visual description of the image to generate, with no reasoning or notes.",
      },
    },
    required: ["prompt"],
  },
};

export async function chat(env: Env, settings: Settings, messages: object[], record: AiInteraction, tools: Tool[] = []) {
  const { chat } = settings;
  const body = chatRequest(chat.apiFormat, messages, {
    tools,
    reasoningEffort: chat.reasoningEffort,
    temperature: chat.temperatureSupported && !rejectsSampling(chat.model) ? chat.temperature : undefined,
  });
  const payload = await runModel(env, chat.model, body, chat.gatewayId, record, settings.revision);
  return chatResponse(payload, chat.model);
}

/** Generate an image with the active profile in the saved image settings. */
export async function generateImage(env: Env, settings: Settings, prompt: string, record: AiInteraction) {
  const profile = settings.image.profiles[settings.image.activeProfile];
  const inputs = { ...profile.parameters, prompt };
  const result = await runModel(env, profile.model, inputs, profile.gatewayId, record, settings.revision);
  const { type, data } = await readMedia(imageOutput(result), "image/jpeg");
  const mime = type.split(";")[0].trim();
  const extension = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  const file: Attachment = { name: `bicture.${extension}`, type, data };
  return { model: profile.model, file };
}

export const pictureCaption = (prompt: string) => (prompt.length <= 300 ? prompt : `${truncate(prompt, 299)}...`);
