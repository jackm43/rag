// Mentions of Ragbot and replies to it: explicit reply context in, one AI reply out.
import { chat, generateImage, PICTURE_TOOL, recordInteractions, type Attribution, type Interaction } from "./ai.ts";
import { botRoles, getMessage, guildAllowed, postMessage, sendTyping } from "./discord.ts";
import type { Env } from "./index.ts";
import type { ToolCall } from "./lib/ai.ts";
import { displayName, MENTION } from "./lib/discord/messages.ts";
import { truncate } from "./lib/discord/rest.ts";
import { loadSettings, type Settings } from "./settings.ts";

// The model alone picks pictures too eagerly (a greeting, a pun), so only offer the tool when the
// message itself asks for an image.
const PICTURE_REQUEST = /\b(?:draw|drawing|sketch|paint|picture|pic|pics|image|images|photo|photos|illustrat\w*|render|bicture)\b/i;

type Job = {
  attribution: Attribution;
  trigger: "mention" | "reply";
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
    trigger: replyingToBot ? "reply" : "mention",
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
  for (let i = 0; i < historyLimit; i++) {
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

/** Run the model's first create_picture call, if any. A failed picture becomes the reply text. */
async function createPicture(env: Env, settings: Settings, calls: ToolCall[], attribution: Attribution) {
  const call = calls.find((candidate) => candidate.name === PICTURE_TOOL.name);
  const prompt = typeof call?.args.prompt === "string" ? truncate(call.args.prompt.trim(), 2000) : "";
  if (!prompt) return null;
  const record: Interaction = {
    source: { ...attribution, kind: "bicture" },
    trigger: "tool",
    prompt,
    startedAt: Date.now(),
    model: settings.image.profiles[settings.image.activeProfile].model,
  };
  try {
    const image = await generateImage(env, settings, prompt, record.source);
    record.aiDurationMs = Date.now() - record.startedAt;
    return { record, caption: "", files: [image.file] };
  } catch (caught) {
    record.error = `model:${caught instanceof Error ? caught.name : "Error"}`;
    console.error(`picture_tool_failed error=${record.error}`);
    return { record, caption: "Could not generate that image. Try a different prompt.", files: [] };
  }
}

/** Keep the typing indicator up until the returned stop function is called. */
function keepTyping(env: Env, channelId: string) {
  const send = () =>
    sendTyping(env, channelId).then(
      (response) => response.body?.cancel(),
      () => console.warn("typing_indicator_failed"),
    );
  send();
  const timer = setInterval(send, 8000);
  return () => clearInterval(timer);
}

async function answer(env: Env, job: Job, startedAt: number) {
  const { attribution } = job;
  const record: Interaction = { source: attribution, trigger: job.trigger, prompt: job.prompt, startedAt, model: "unknown" };
  let picture: Awaited<ReturnType<typeof createPicture>> = null;
  let step = "settings";
  const stopTyping = keepTyping(env, attribution.channelId);
  try {
    const settings = await loadSettings(env.DB);
    record.model = settings.chat.model;
    step = "context";
    const messages = await conversation(env, job, settings.chat.historyLimit);
    record.contextMessages = messages.length - 1;
    step = "model";
    const system = { role: "system", content: settings.chat.prompt.trim() };
    const tools = PICTURE_REQUEST.test(job.prompt) ? [PICTURE_TOOL] : [];
    const aiStart = Date.now();
    const result = await chat(env, settings, [system, ...messages], attribution, tools);
    record.aiDurationMs = Date.now() - aiStart;
    record.model = result.model;
    record.usage = result.usage;
    picture = await createPicture(env, settings, result.toolCalls, attribution);
    // Keep the model's text and formatting; only enforce the length limit and an empty fallback.
    // A failed picture says so instead of the model's text, which may promise an image.
    if (picture && !picture.files.length) record.responseText = picture.caption;
    else if (result.content.trim()) record.responseText = truncate(result.content, 1900);
    // The picture prompt is the model's working text, so a picture with no reply text posts alone.
    else record.responseText = picture ? "" : "I could not generate a response.";
    step = "discord";
    stopTyping();
    const response = await postMessage(env, attribution.channelId, record.responseText, attribution.messageId, picture?.files);
    if (!response.ok) record.error = `discord:${response.status}`;
  } catch (caught) {
    // Third-party errors can contain credential-bearing URLs or payloads; record only the type.
    record.error = `${step}:${caught instanceof Error ? caught.name : "Error"}`;
  }
  stopTyping();
  if (record.error) {
    console.error(`ai_job_failed error=${record.error}`);
    // A picture only counts once Discord has accepted the reply carrying it.
    if (picture) picture.record.error ??= record.error;
  }
  await recordInteractions(env, picture ? [record, picture.record] : [record]);
}
