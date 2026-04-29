import {
  type AiJob,
  type AiChannelJob,
  type Env,
} from "../types";

type AiTextResponse = {
  response?: string;
};

type AiResponse = {
  content: string;
  model: string;
  aiDurationMs: number;
};

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const AI_RETRY_DELAY_SECONDS = 10;
const DEFAULT_AI_RESPONSE_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const AI_RESPONSE_MODEL_SETTING_KEY = "ai_response_model";
let aiTelemetrySchemaReady: Promise<void> | null = null;

const sanitizeAiText = (value: string) =>
  value
    .replace(/<@!?\d+>/g, "")
    .replace(/\b\d{17,20}\b/g, "")
    .replace(/@/g, "")
    .replace(/\s+/g, " ")
    .trim();

const getAiResponseModel = async (env: Env) => {
  try {
    const row = await env.DB.prepare("SELECT value FROM rag_settings WHERE key = ?")
      .bind(AI_RESPONSE_MODEL_SETTING_KEY)
      .first<{ value: string }>();
    const model = row?.value?.trim();
    return model && model.startsWith("@cf/") ? model : DEFAULT_AI_RESPONSE_MODEL;
  } catch {
    return DEFAULT_AI_RESPONSE_MODEL;
  }
};

const ensureAiTelemetrySchema = (env: Env) => {
  aiTelemetrySchemaReady ??= env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS rag_ai_interactions (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, channel_id TEXT, message_id TEXT, requester_user_id TEXT, requester_username TEXT, prompt TEXT NOT NULL, response_text TEXT, model TEXT NOT NULL, ai_duration_ms INTEGER, total_duration_ms INTEGER, status TEXT NOT NULL, error_message TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  ).run().then(() => undefined);
  return aiTelemetrySchemaReady;
};

const recordAiInteraction = async (
  env: Env,
  job: AiChannelJob,
  model: string,
  totalDurationMs: number,
  status: string,
  responseText: string | null,
  aiDurationMs: number | null,
  errorMessage: string | null,
) => {
  try {
    await ensureAiTelemetrySchema(env);
    await env.DB.prepare(
      "INSERT INTO rag_ai_interactions (kind, channel_id, message_id, requester_user_id, requester_username, prompt, response_text, model, ai_duration_ms, total_duration_ms, status, error_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        job.kind,
        job.channelId,
        job.messageId ?? null,
        job.requesterUserId ?? null,
        job.requesterUsername ?? null,
        job.prompt,
        responseText,
        model,
        aiDurationMs,
        totalDurationMs,
        status,
        errorMessage,
      )
      .run();
  } catch {
    // Telemetry should not affect Discord delivery or queue retry behavior.
  }
};

const generateAiAnswer = async (env: Env, prompt: string): Promise<AiResponse> => {
  const model = await getAiResponseModel(env);
  const startedAt = Date.now();
  const aiResult = await env.AI.run(model, {
    messages: [
      {
        role: "system",
        content:
          "Answer clearly and concisely in plain text. You're in a heavy banter server so be playful and sarcastic.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    max_tokens: 500,
    temperature: 0.7,
  });

  const aiDurationMs = Date.now() - startedAt;
  const text = sanitizeAiText((aiResult as AiTextResponse).response ?? "");
  return {
    content: text.length > 0 ? text.slice(0, 1900) : "I could not generate a response.",
    model,
    aiDurationMs,
  };
};

const postDiscordChannelMessage = async (job: AiChannelJob, env: Env, content: string) =>
  fetch(`${DISCORD_API_BASE_URL}/channels/${job.channelId}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      content,
      allowed_mentions: {
        parse: [],
      },
    }),
  });

export const enqueueAiChannelPrompt = async (
  env: Env,
  channelId: string,
  prompt: string,
  metadata: Omit<AiChannelJob, "kind" | "channelId" | "prompt"> = {},
) =>
  env.AI_JOBS.send({
    kind: "channel",
    channelId,
    ...metadata,
    prompt,
  });

export const processAiQueueMessage = async (message: Message<AiJob>, env: Env) => {
  const startedAt = Date.now();
  let model = DEFAULT_AI_RESPONSE_MODEL;
  let aiDurationMs: number | null = null;
  let content: string | null = null;
  try {
    const aiResponse = await generateAiAnswer(env, message.body.prompt);
    content = aiResponse.content;
    model = aiResponse.model;
    aiDurationMs = aiResponse.aiDurationMs;
    const response = await postDiscordChannelMessage(message.body, env, content);

    if (response.ok) {
      await recordAiInteraction(env, message.body, model, Date.now() - startedAt, "ok", content, aiDurationMs, null);
      message.ack();
      return;
    }

    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      await recordAiInteraction(
        env,
        message.body,
        model,
        Date.now() - startedAt,
        `discord_${response.status}`,
        content,
        aiDurationMs,
        await response.text().catch(() => null),
      );
      message.ack();
      return;
    }

    await recordAiInteraction(
      env,
      message.body,
      model,
      Date.now() - startedAt,
      `retry_discord_${response.status}`,
      content,
      aiDurationMs,
      await response.text().catch(() => null),
    );
    message.retry({ delaySeconds: AI_RETRY_DELAY_SECONDS });
  } catch (error) {
    await recordAiInteraction(
      env,
      message.body,
      model,
      Date.now() - startedAt,
      "retry_error",
      content,
      aiDurationMs,
      error instanceof Error ? error.message : String(error),
    );
    message.retry({ delaySeconds: AI_RETRY_DELAY_SECONDS });
  }
};
