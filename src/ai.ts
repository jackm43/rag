// Ragbot's model calls through the AI binding: chat with the picture tool, and /bicture images.
import type { Env } from "./index.ts";
import { chatRequest, chatResponse, imageOutput, rejectsSampling, type Tool } from "./lib/ai.ts";
import type { Attachment } from "./lib/discord/messages.ts";
import { truncate } from "./lib/discord/rest.ts";
import { readMedia } from "./lib/media.ts";
import type { Settings } from "./settings.ts";

export type Attribution = { kind: string; userId: string; username: string; channelId: string; messageId: string };

/** Run a model, tagging AI Gateway logs (at most five metadata entries) with who asked. */
export function runModel(
  env: Env,
  model: string,
  inputs: Record<string, unknown>,
  gatewayId: string | undefined,
  attribution: Attribution,
  revision: string,
): Promise<any> {
  if (!gatewayId) return env.AI.run(model, inputs);
  const metadata = {
    ragbot_kind: attribution.kind,
    discord_user_id: attribution.userId,
    discord_channel_id: attribution.channelId,
    discord_message_id: attribution.messageId,
    ragbot_settings_revision: revision,
  };
  return env.AI.run(model, inputs, { gateway: { id: gatewayId, metadata } });
}

/** Lets a chat model post a generated picture instead of only text. */
export const PICTURE_TOOL: Tool = {
  name: "create_picture",
  description:
    "Generate an image and post it with your reply. Use it only when someone asks you to make, draw, show or picture something.",
  parameters: {
    type: "object",
    properties: { prompt: { type: "string", description: "A detailed description of the image to generate." } },
    required: ["prompt"],
  },
};

export async function chat(env: Env, settings: Settings, messages: object[], attribution: Attribution, tools: Tool[] = []) {
  const { chat } = settings;
  const body = chatRequest(chat.apiFormat, messages, {
    tools,
    reasoningEffort: chat.reasoningEffort,
    temperature: chat.temperatureSupported && !rejectsSampling(chat.model) ? chat.temperature : undefined,
  });
  const payload = await runModel(env, chat.model, body, chat.gatewayId, attribution, settings.revision);
  return chatResponse(payload, chat.model);
}

/** Generate an image with the active profile in the saved image settings. */
export async function generateImage(env: Env, settings: Settings, prompt: string, attribution: Attribution) {
  const profile = settings.image.profiles[settings.image.activeProfile];
  const inputs = { ...profile.parameters, prompt };
  const result = await runModel(env, profile.model, inputs, profile.gatewayId, attribution, settings.revision);
  const { type, data } = await readMedia(imageOutput(result), "image/jpeg");
  const mime = type.split(";")[0].trim();
  const extension = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  const file: Attachment = { name: `bicture.${extension}`, type, data };
  return { model: profile.model, file };
}

export const pictureCaption = (prompt: string) => (prompt.length <= 300 ? prompt : `${truncate(prompt, 299)}...`);

/** Record a generated picture, from /bicture or the chat tool, for analytics and prompt history. */
export async function recordPicture(
  env: Env,
  source: Attribution,
  prompt: string,
  model: string,
  startedAt: number,
  error: string | null,
) {
  try {
    await env.DB.prepare(
      "INSERT INTO rag_ai_interactions (kind, channel_id, message_id, requester_user_id, requester_username, prompt, model, total_duration_ms, status, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("bicture", source.channelId, source.messageId, source.userId, source.username, prompt, model, Date.now() - startedAt, error ? "error" : "ok", error)
      .run();
  } catch {
    console.warn("interaction_record_failed");
  }
}
