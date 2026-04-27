import {
  type AiJob,
  type AiChannelJob,
  type Env,
} from "../types";

type AiTextResponse = {
  response?: string;
};

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const AI_RETRY_DELAY_SECONDS = 10;

const sanitizeAiText = (value: string) =>
  value
    .replace(/<@!?\d+>/g, "")
    .replace(/\b\d{17,20}\b/g, "")
    .replace(/@/g, "")
    .replace(/\s+/g, " ")
    .trim();

const generateAiAnswer = async (env: Env, prompt: string) => {
  const aiResult = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
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

  const text = sanitizeAiText((aiResult as AiTextResponse).response ?? "");
  return text.length > 0 ? text.slice(0, 1900) : "I could not generate a response.";
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

export const enqueueAiChannelPrompt = async (env: Env, channelId: string, prompt: string) =>
  env.AI_JOBS.send({
    kind: "channel",
    channelId,
    prompt,
  });

export const processAiQueueMessage = async (message: Message<AiJob>, env: Env) => {
  try {
    const content = await generateAiAnswer(env, message.body.prompt);
    const response = await postDiscordChannelMessage(message.body, env, content);

    if (response.ok) {
      message.ack();
      return;
    }

    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      message.ack();
      return;
    }

    message.retry({ delaySeconds: AI_RETRY_DELAY_SECONDS });
  } catch {
    message.retry({ delaySeconds: AI_RETRY_DELAY_SECONDS });
  }
};
