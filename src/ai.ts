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

/**
 * One row per model call, for usage analytics and prompt history. AI Gateway already logs tokens,
 * cost and model latency; these rows add who asked, how, with how much context, and whether Discord
 * received the result.
 */
export type Interaction = {
  source: Attribution;
  trigger: "mention" | "reply" | "command" | "tool";
  prompt: string;
  startedAt: number;
  model: string;
  contextMessages?: number;
  aiDurationMs?: number;
  usage?: { prompt: number | null; completion: number | null; total: number | null };
  responseText?: string;
  error?: string; // `<step>:<error type>`, such as `model:TypeError` or `discord:403`
};

export async function recordInteractions(env: Env, interactions: Interaction[]) {
  const finishedAt = Date.now();
  const insert = env.DB.prepare(
    "INSERT INTO rag_ai_interactions (kind, channel_id, message_id, requester_user_id, requester_username, prompt, response_text, model, ai_duration_ms, total_duration_ms, status, error_message, prompt_tokens, completion_tokens, total_tokens, triggered_by, context_messages) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  try {
    await env.DB.batch(
      interactions.map(({ source, usage, ...record }) =>
        insert.bind(
          source.kind,
          source.channelId,
          source.messageId,
          source.userId,
          source.username,
          record.prompt,
          record.responseText ?? null,
          record.model,
          record.aiDurationMs ?? null,
          finishedAt - record.startedAt,
          record.error ? "error" : "ok",
          record.error ?? null,
          usage?.prompt ?? null,
          usage?.completion ?? null,
          usage?.total ?? null,
          record.trigger,
          record.contextMessages ?? null,
        ),
      ),
    );
  } catch {
    console.warn("interaction_record_failed");
  }
}
