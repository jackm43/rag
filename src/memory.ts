import { errorMessage, logger } from "./logger";
import type { AiChannelJob, DiscordMessage, Env } from "./types";

const MAX_STORED_MESSAGE_LENGTH = 1200;
const MAX_MEMORY_VALUE_LENGTH = 1000;
const MAX_CONTEXT_LINE_LENGTH = 240;

type RecordMessageOptions = {
  mentionsBot?: boolean;
};

type MemoryScope = "server" | "channel" | "user";

type ExplicitMemory = {
  scope: MemoryScope;
  label: string;
  value: string;
};

type MemoryRow = {
  scope: string;
  label: string;
  value: string;
  updated_at: string;
};

type MessageRow = {
  author_display_name: string | null;
  author_username: string | null;
  content: string | null;
};

type CountRow = {
  count: number;
};

const normalizeWhitespace = (value: string) => value.replace(/\s+/g, " ").trim();

const truncate = (value: string, maxLength: number) =>
  value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;

const cleanStoredText = (value: string | undefined) => {
  const normalized = normalizeWhitespace(value ?? "");
  return normalized.length > 0 ? truncate(normalized, MAX_STORED_MESSAGE_LENGTH) : null;
};

const cleanMemoryValue = (value: string) =>
  truncate(
    normalizeWhitespace(value)
      .replace(/<@[!&]?\d+>/g, "")
      .replace(/@(everyone|here)/g, "$1"),
    MAX_MEMORY_VALUE_LENGTH,
  );

const displayNameFromMessage = (message: DiscordMessage) =>
  message.member?.nick?.trim() ||
  message.author?.global_name?.trim() ||
  message.author?.username?.trim() ||
  null;

const createMemoryLabel = (value: string) =>
  normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 8)
    .join("-") || "note";

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (match) => `\\${match}`);

const keywordPattern = (prompt: string) => {
  const keywords = normalizeWhitespace(prompt)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(" ")
    .filter((word) => word.length >= 4)
    .slice(0, 5);
  return keywords.length > 0 ? `%${escapeLike(keywords[0])}%` : "%";
};

export const recordDiscordMessage = async (
  env: Env,
  message: DiscordMessage,
  options: RecordMessageOptions = {},
) => {
  const content = cleanStoredText(message.content);
  await env.DB.prepare(
    "INSERT INTO discord_messages (message_id, guild_id, channel_id, author_user_id, author_username, author_display_name, content, is_bot, mentions_bot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET guild_id = excluded.guild_id, channel_id = excluded.channel_id, author_user_id = excluded.author_user_id, author_username = excluded.author_username, author_display_name = excluded.author_display_name, content = excluded.content, is_bot = excluded.is_bot, mentions_bot = excluded.mentions_bot, observed_at = CURRENT_TIMESTAMP",
  )
    .bind(
      message.id,
      message.guild_id ?? null,
      message.channel_id,
      message.author?.id ?? null,
      message.author?.username ?? null,
      displayNameFromMessage(message),
      content,
      message.author?.bot ? 1 : 0,
      options.mentionsBot ? 1 : 0,
    )
    .run();
};

export const recordDiscordMessages = async (
  env: Env,
  messages: DiscordMessage[],
  options: RecordMessageOptions = {},
) => {
  for (const message of messages) {
    try {
      await recordDiscordMessage(env, message, options);
    } catch (error) {
      logger.debug("discord_message_record_failed", { error: errorMessage(error) });
    }
  }
};

export const extractExplicitMemory = (prompt: string): ExplicitMemory | null => {
  const match = prompt.match(/\b(?:remember|note|save|keep in mind)\b(?:\s+(?:that|this))?\s+(.+)/i);
  if (!match) {
    return null;
  }

  let value = cleanMemoryValue(match[1]);
  if (value.length < 4) {
    return null;
  }

  let scope: MemoryScope = "server";
  if (/\b(for me|about me|my preference|my preferences)\b/i.test(prompt)) {
    scope = "user";
  } else if (/\b(this channel|the channel|channel memory)\b/i.test(prompt)) {
    scope = "channel";
  }

  value = value
    .replace(/\b(?:for this server|for the server|for this workspace|for me|about me|for this channel)\b/gi, "")
    .trim();

  if (value.length < 4) {
    return null;
  }

  return {
    scope,
    label: createMemoryLabel(value),
    value,
  };
};

export const storeExplicitMemory = async (
  env: Env,
  job: AiChannelJob,
  memory: ExplicitMemory,
) => {
  await env.DB.prepare(
    "INSERT INTO assistant_memories (scope, guild_id, channel_id, user_id, label, value, source_message_id, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, 1.0)",
  )
    .bind(
      memory.scope,
      job.guildId ?? null,
      memory.scope === "channel" ? job.channelId : null,
      memory.scope === "user" ? job.requesterUserId ?? null : null,
      memory.label,
      memory.value,
      job.messageId ?? null,
    )
    .run();
};

const getRelevantMemories = async (env: Env, job: AiChannelJob, prompt: string) => {
  const result = await env.DB.prepare(
    "SELECT scope, label, value, updated_at FROM assistant_memories WHERE (guild_id IS NULL OR guild_id = ?) AND (channel_id IS NULL OR channel_id = ?) AND (user_id IS NULL OR user_id = ?) AND (value LIKE ? ESCAPE '\\' OR label LIKE ? ESCAPE '\\') ORDER BY updated_at DESC LIMIT 8",
  )
    .bind(
      job.guildId ?? null,
      job.channelId,
      job.requesterUserId ?? null,
      keywordPattern(prompt),
      keywordPattern(prompt),
    )
    .run<MemoryRow>();
  return result.results ?? [];
};

const getRecentChannelMessages = async (env: Env, channelId: string) => {
  const result = await env.DB.prepare(
    "SELECT author_display_name, author_username, content FROM discord_messages WHERE channel_id = ? AND content IS NOT NULL AND is_bot = 0 ORDER BY observed_at DESC LIMIT 8",
  )
    .bind(channelId)
    .run<MessageRow>();
  return result.results ?? [];
};

const getUsageCount = async (env: Env, channelId: string) =>
  env.DB.prepare(
    "SELECT COUNT(*) AS count FROM rag_ai_interactions WHERE channel_id = ? AND created_at >= datetime('now', '-30 days')",
  )
    .bind(channelId)
    .first<CountRow>();

export const loadWorkspaceContext = async (
  env: Env,
  job: AiChannelJob,
  prompt: string,
) => {
  try {
    const [memories, recentMessages, usage] = await Promise.all([
      getRelevantMemories(env, job, prompt),
      getRecentChannelMessages(env, job.channelId),
      getUsageCount(env, job.channelId),
    ]);

    const lines: string[] = [];
    if (memories.length > 0) {
      lines.push("Relevant durable memory:");
      for (const memory of memories) {
        lines.push(`- [${memory.scope}/${memory.label}] ${truncate(memory.value, MAX_CONTEXT_LINE_LENGTH)}`);
      }
    }

    if (recentMessages.length > 0) {
      lines.push("Recently observed server messages:");
      for (const message of recentMessages.reverse()) {
        const name = message.author_display_name || message.author_username || "user";
        const content = truncate(message.content ?? "", MAX_CONTEXT_LINE_LENGTH);
        if (content) {
          lines.push(`- ${name}: ${content}`);
        }
      }
    }

    if (usage?.count) {
      lines.push(`Assistant usage in this channel over the last 30 days: ${usage.count} AI replies.`);
    }

    return lines.length > 0 ? lines.join("\n") : null;
  } catch (error) {
    logger.debug("workspace_context_load_failed", { error: errorMessage(error) });
    return null;
  }
};
