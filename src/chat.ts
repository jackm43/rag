// Mentions of Ragbot and replies to it: explicit reply context in, one AI reply out.
import { chat, chatConfig, loadSettings, type Attribution } from "./ai.ts";
import { botRoles, displayName, getMessage, guildAllowed, postMessage } from "./discord.ts";
import type { Env } from "./index.ts";
import { truncate } from "./lib/discord/rest.ts";

const MENTION = /<@([!&]?)([^>\s]+)>/g;

type Job = {
  attribution: Attribution;
  prompt: string;
  botUserId: string;
  replyId?: string;
  replyChannel: string;
  source: any;
};

/** Handle a gateway MESSAGE_CREATE; only mentions of the bot and replies to it are answered. */
export async function handleMessage(env: Env, message: any, botUserId: string | null) {
  if (message.author.bot || !botUserId) return;
  if (!guildAllowed(env, message.guild_id) || !message.content.replace(MENTION, " ").trim()) return;
  const startedAt = Date.now();
  let job: Job | null;
  try {
    job = await resolve(env, message, botUserId);
  } catch {
    console.error("gateway_message_resolve_failed");
    return;
  }
  if (job) await answer(env, job, startedAt);
}

async function resolve(env: Env, message: any, botUserId: string): Promise<Job | null> {
  const channelId: string = message.channel_id;
  const replyId: string | undefined = message.message_reference?.message_id;
  const replyChannel: string = message.message_reference?.channel_id ?? channelId;
  let referenced = message.referenced_message;
  if (replyId && replyChannel === channelId && referenced == null) {
    try {
      referenced = await getMessage(env, channelId, replyId);
    } catch {
      console.warn("reply_context_fetch_failed");
    }
    message = { ...message, referenced_message: referenced };
  }
  // Replies to Ragbot count even when the author switched Discord's reply ping off.
  const replyingToBot = replyChannel === channelId && referenced?.author.id === botUserId;
  const users = new Set<string>(message.mentions?.map((user: any) => user.id));
  const roles = new Set<string>(message.mention_roles);
  for (const [, marker, id] of truncate(message.content, 4000).matchAll(MENTION)) {
    (marker === "&" ? roles : users).add(id);
  }
  let mentioned = users.has(botUserId) || users.has(env.DISCORD_APPLICATION_ID);
  if (!replyingToBot && !mentioned && roles.size && message.guild_id) {
    mentioned = (await botRoles(env, message.guild_id, botUserId)).some((role) => roles.has(role));
  }
  if (!replyingToBot && !mentioned) return null;
  const prompt = messageText(message, botUserId);
  if (!prompt) return null;
  return {
    attribution: {
      kind: "channel_reply",
      userId: message.author.id,
      username: displayName(message.author, message.member?.nick),
      channelId,
      messageId: message.id,
    },
    prompt,
    botUserId,
    replyId,
    replyChannel,
    source: message,
  };
}

// Speaker names replace mentions; attachment labels name files without claiming their contents.
function messageText(message: any, botUserId: string) {
  const names = new Map<string, string>(message.mentions?.map((user: any) => [user.id, displayName(user)]));
  const text = message.content
    .replace(MENTION, (_: string, marker: string, id: string) =>
      id === botUserId ? "" : (names.get(id) ?? (marker === "&" ? "[role]" : "[user]")),
    )
    .trim();
  const attachments = (message.attachments ?? [])
    .slice(0, 5)
    .map((file: any) => `[attachment: ${file.filename}; contents not provided]`);
  return truncate([text, ...attachments].filter(Boolean).join("\n"), 4000);
}

/** Follow the explicit reply chain only; never widen a request to nearby channel chatter. */
async function conversation(env: Env, job: Job, historyLimit: number) {
  const { attribution } = job;
  const chain: any[] = [];
  const seen = new Set([attribution.messageId]);
  let referenceId = job.replyId;
  let channelId = job.replyChannel;
  let embedded = job.source.referenced_message;
  for (let i = 0; i < Math.max(1, Math.min(historyLimit, 12)); i++) {
    if (!referenceId || seen.has(referenceId) || channelId !== attribution.channelId) break;
    seen.add(referenceId);
    let referenced = embedded?.id === referenceId ? embedded : null;
    if (!referenced) {
      try {
        referenced = await getMessage(env, channelId, referenceId);
      } catch {
        console.warn("reply_context_fetch_failed");
        break;
      }
    }
    // A deleted or unavailable ancestor ends the chain; the request is still answered.
    if (referenced?.id !== referenceId || referenced.channel_id !== attribution.channelId) break;
    chain.push(referenced);
    embedded = referenced.referenced_message;
    referenceId = referenced.message_reference?.message_id;
    channelId = referenced.message_reference?.channel_id ?? attribution.channelId;
  }
  const ordered = chain.reverse();
  const names = new Map<string, string>(ordered.map((message) => [message.author.id, displayName(message.author, message.member?.nick)]));
  names.set(attribution.userId, attribution.username);
  const messages = [];
  for (const message of ordered) {
    const content = messageText(message, job.botUserId);
    if (!content) continue;
    if (message.author.id !== job.botUserId) {
      messages.push({ role: "user", content: `${names.get(message.author.id)}: ${content}` });
    } else if (!/\bjust ragged\./.test(content) && !content.startsWith("Ragboard\n")) {
      // Command results are not conversation.
      messages.push({ role: "assistant", content });
    }
  }
  messages.push({ role: "user", content: `${attribution.username}: ${job.prompt}` });
  return messages;
}

async function answer(env: Env, job: Job, startedAt: number) {
  const { attribution } = job;
  let model = "unknown";
  let status = "ok";
  let error: string | null = null;
  let responseText: string | null = null;
  let aiDuration: number | null = null;
  let usage: Record<string, number | null> = {};
  try {
    const aiStart = Date.now();
    const config = chatConfig(await loadSettings(env.DB));
    const messages = await conversation(env, job, config.historyLimit);
    const result = await chat(env, config, [{ role: "system", content: config.prompt }, ...messages], attribution);
    aiDuration = Date.now() - aiStart;
    ({ model, usage } = result);
    // Keep the model's text and formatting; only enforce the length limit and an empty fallback.
    responseText = result.content.trim() ? truncate(result.content, 1900) : "I could not generate a response.";
    const response = await postMessage(env, attribution.channelId, responseText, attribution.messageId);
    if (!response.ok) throw new Error(`discord_channel_post_failed_${response.status}`);
  } catch (caught) {
    status = "error";
    // Third-party errors can contain credential-bearing URLs or payloads; record only the type.
    error = caught instanceof Error ? caught.name : "Error";
    console.error(`ai_job_failed error_type=${error}`);
  }
  try {
    await env.DB.prepare(
      "INSERT INTO rag_ai_interactions (kind, channel_id, message_id, requester_user_id, requester_username, prompt, response_text, model, ai_duration_ms, total_duration_ms, status, error_message, prompt_tokens, completion_tokens, total_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        attribution.kind,
        attribution.channelId,
        attribution.messageId,
        attribution.userId,
        attribution.username,
        job.prompt,
        responseText,
        model,
        aiDuration,
        Date.now() - startedAt,
        status,
        error,
        usage.prompt ?? null,
        usage.completion ?? null,
        usage.total ?? null,
      )
      .run();
  } catch {
    console.warn("interaction_record_failed");
  }
}
