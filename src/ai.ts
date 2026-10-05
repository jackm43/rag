// AI settings from D1, model calls through the AI binding, and provider response parsing.
import type { Attachment } from "./discord.ts";
import type { Env } from "./index.ts";
import { truncate } from "./lib/discord/rest.ts";

export const SETTINGS_SQL = "SELECT revision, document FROM ai_runtime_settings WHERE id = 1";
const RESOURCES = ["bicture-image.json", "discord-response-system-prompt.md", "discord-response.json"];
const IMAGE_PARAMETERS = ["response_format", "aspect_ratio", "quality", "resolution"];
export const MEDIA_MAX_BYTES = 25 * 1024 * 1024;

export type Settings = { schemaVersion: 2; revision: string; updatedAt?: string; resources: Record<string, string> };
export type Attribution = { kind: string; userId: string; username: string; channelId: string; messageId: string };

export class MediaTooLargeError extends Error {
  name = "MediaTooLargeError";
}

const isObject = (value: unknown): value is Record<string, any> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Settings are edited data, so check every field the bot relies on before using them. */
export function parseSettings(raw: string): Settings {
  const data = JSON.parse(raw);
  if (data?.schemaVersion !== 2) throw new Error("invalid settings version");
  const resources = data.resources;
  if (!isObject(resources) || Object.keys(resources).sort().join() !== RESOURCES.join()) {
    throw new Error("incomplete settings snapshot");
  }
  if (Object.values(resources).some((value) => typeof value !== "string" || value.length > 100_000)) {
    throw new Error("invalid settings resource");
  }
  const chat = JSON.parse(resources["discord-response.json"]);
  if (typeof chat?.model !== "string" || !chat.model.trim()) throw new Error("missing settings model");
  const image = JSON.parse(resources["bicture-image.json"]);
  if (!isObject(image?.profiles) || !Object.hasOwn(image.profiles, image.activeProfile)) {
    throw new Error("invalid image profiles");
  }
  for (const profile of Object.values<any>(image.profiles)) {
    if (typeof profile?.model !== "string") throw new Error("invalid image profile");
    const parameters = profile.parameters;
    if (
      parameters !== undefined &&
      (!isObject(parameters) ||
        Object.entries(parameters).some(([key, value]) => !IMAGE_PARAMETERS.includes(key) || typeof value !== "string"))
    ) {
      throw new Error("invalid image parameters");
    }
  }
  return data;
}

/** Each AI request reads the primary D1 row, so a saved change applies to the next request. */
export async function loadSettings(db: D1Database) {
  const row = await db.prepare(SETTINGS_SQL).first<{ revision: string; document: string }>();
  if (!row) throw new Error("AI settings are not initialized in D1");
  const settings = parseSettings(row.document);
  if (settings.revision !== row.revision) throw new Error("settings revision mismatch");
  return settings;
}

function number(value: unknown, fallback: number, minimum: number, maximum = Infinity) {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function chatConfig(settings: Settings) {
  const data = JSON.parse(settings.resources["discord-response.json"]);
  const apiFormat: string = data.apiFormat ?? "chat-completions";
  if (apiFormat !== "chat-completions" && apiFormat !== "responses") throw new Error("unsupported chat API format");
  return {
    revision: settings.revision,
    model: data.model.trim() as string,
    prompt: settings.resources["discord-response-system-prompt.md"].trim(),
    apiFormat,
    temperature: number(data.temperature, 0.7, 0, 2),
    temperatureSupported: (data.temperatureSupported ?? true) === true,
    reasoningEffort: ["low", "medium", "high", "xhigh"].includes(data.reasoningEffort) ? (data.reasoningEffort as string) : undefined,
    gatewayId: typeof data.gatewayId === "string" && data.gatewayId.trim() ? data.gatewayId.trim() : undefined,
    historyLimit: Math.trunc(number(data.historyLimit, 12, 1)),
  };
}

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

export type Tool = { name: string; description: string; parameters: object };
export type ToolCall = { name: string; args: Record<string, any> };

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

export async function chat(
  env: Env,
  config: ReturnType<typeof chatConfig>,
  messages: object[],
  attribution: Attribution,
  tools: Tool[] = [],
) {
  const responses = config.apiFormat === "responses";
  const body: Record<string, unknown> = responses ? { input: messages } : { messages };
  if (tools.length) {
    body.tools = tools.map((tool) => (responses ? { type: "function", ...tool } : { type: "function", function: tool }));
  }
  if (config.reasoningEffort && responses) body.reasoning = { effort: config.reasoningEffort };
  if (config.reasoningEffort && !responses) body.reasoning_effort = config.reasoningEffort;
  // Reasoning models reject sampling controls.
  if (config.temperatureSupported && !/^openai\/(?:gpt-[5-9]|o[1-9])/.test(config.model)) {
    body.temperature = config.temperature;
  }
  const payload = await runModel(env, config.model, body, config.gatewayId, attribution, config.revision);
  const usage = isObject(payload?.usage) ? payload.usage : {};
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
  return {
    content: text(payload),
    toolCalls: toolCalls(payload),
    model: typeof payload?.model === "string" && payload.model ? payload.model : config.model,
    usage: {
      prompt: count(usage.prompt_tokens ?? usage.input_tokens),
      completion: count(usage.completion_tokens ?? usage.output_tokens),
      total: count(usage.total_tokens),
    },
  };
}

// Chat Completions, Responses, and Workers AI text shapes.
function text(payload: any): string {
  if (typeof payload === "string") return payload;
  if (typeof payload?.output_text === "string" && payload.output_text) return payload.output_text;
  if (Array.isArray(payload?.output) && payload.output.length) {
    return payload.output
      .filter((output: any) => output.type === "message")
      .flatMap((output: any) => output.content ?? [])
      .filter((part: any) => part.type === "output_text")
      .map((part: any) => part.text)
      .join("\n\n");
  }
  if (typeof payload?.response === "string") return payload.response;
  const content = payload?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

// Chat Completions, Responses, and Workers AI tool call shapes; arguments arrive as JSON text.
function toolCalls(payload: any): ToolCall[] {
  const calls: any[] = [
    ...(payload?.choices?.[0]?.message?.tool_calls ?? []).map((call: any) => call.function),
    ...(Array.isArray(payload?.output) ? payload.output.filter((output: any) => output.type === "function_call") : []),
    ...(Array.isArray(payload?.tool_calls) ? payload.tool_calls : []),
  ];
  return calls.flatMap((call) => {
    try {
      const args = typeof call?.arguments === "string" ? JSON.parse(call.arguments) : call?.arguments;
      return typeof call?.name === "string" && isObject(args) ? [{ name: call.name, args }] : [];
    } catch {
      return [];
    }
  });
}

/** Generate an image with the active profile in the saved image settings. */
export async function generateImage(env: Env, settings: Settings, prompt: string, attribution: Attribution) {
  const image = JSON.parse(settings.resources["bicture-image.json"]);
  const profile = image.profiles[image.activeProfile];
  const parameters = profile.parameters ?? {
    response_format: profile.responseFormat,
    aspect_ratio: profile.aspectRatio,
    quality: profile.quality,
    resolution: profile.resolution,
  };
  const result = await runModel(env, profile.model, { ...parameters, prompt }, profile.gatewayId, attribution, settings.revision);
  return { model: profile.model as string, file: await imageFile(result) };
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

/** Turn an image model result (bytes, stream, base64, data URI or HTTPS URL) into a capped file. */
export async function imageFile(result: unknown): Promise<Attachment> {
  let type = "image/jpeg";
  let data: Uint8Array;
  if (result instanceof ReadableStream) data = await readCapped(result);
  else if (result instanceof ArrayBuffer) data = new Uint8Array(result);
  else if (ArrayBuffer.isView(result)) data = new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
  else {
    let value = imageSource(result);
    if (/^https:\/\//i.test(value)) {
      const response = await download(value);
      type = response.headers.get("content-type") || type;
      data = await readCapped(response.body);
    } else {
      if (/^data:/i.test(value)) {
        const comma = value.indexOf(",");
        if (comma < 0 || !/;base64$/i.test(value.slice(0, comma))) throw new Error("invalid image data URI");
        type = value.slice(5, comma - 7);
        value = value.slice(comma + 1);
        if (!type || !value) throw new Error("invalid image data URI");
      }
      if (value.length > Math.floor((MEDIA_MAX_BYTES + 2) / 3) * 4) throw new MediaTooLargeError("image exceeds 25 MiB");
      data = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    }
  }
  if (data.byteLength > MEDIA_MAX_BYTES) throw new MediaTooLargeError("image exceeds 25 MiB");
  const mime = type.split(";")[0].trim();
  const extension = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  return { name: `bicture.${extension}`, type, data };
}

// Providers return the image itself, base64 or URL fields, or either nested under `result`.
function imageSource(result: any): string {
  for (let depth = 0; depth < 3; depth++) {
    const candidates = [result, result?.image, result?.data?.[0]?.b64_json, result?.data?.[0]?.url];
    const value = candidates.find((candidate) => typeof candidate === "string" && candidate);
    if (value) return value;
    result = result?.result;
  }
  throw new Error("missing_bicture_image");
}

// Provider media can come from any host: no credentials, a timeout, and a size cap while streaming.
async function download(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`media download failed (${response.status})`);
  if (Number(response.headers.get("content-length")) > MEDIA_MAX_BYTES) {
    await response.body?.cancel();
    throw new MediaTooLargeError("media response exceeds 25 MiB");
  }
  return response;
}

async function readCapped(body: ReadableStream<Uint8Array> | null) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body ?? []) {
    size += chunk.byteLength;
    if (size > MEDIA_MAX_BYTES) throw new MediaTooLargeError("media response exceeds 25 MiB");
    chunks.push(chunk);
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}
