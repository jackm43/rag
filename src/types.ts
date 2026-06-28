export type DiscordInteraction = {
  application_id?: string;
  channel_id?: string;
  guild_id?: string;
  token?: string;
  type: number;
  data?: {
    name?: string;
    options?: Array<{ name: string; value: string | number | boolean }>;
    resolved?: {
      users?: Record<string, { id: string; username: string; global_name?: string | null }>;
      members?: Record<string, { nick?: string | null }>;
    };
  };
  user?: { id: string; username: string; global_name?: string | null };
  member?: {
    nick?: string | null;
    user?: { id: string; username: string; global_name?: string | null };
  };
  resolved?: {
    users?: Record<string, { id: string; username: string; global_name?: string | null }>;
    members?: Record<string, { nick?: string | null }>;
  };
};

export type AiThreadStartJob = {
  kind: "thread_start";
  channelId: string;
  messageId: string;
  botUserId?: string;
  requesterUserId?: string;
  requesterUsername?: string;
  prompt: string;
  replyMessageId?: string;
  replyChannelId?: string;
};

export type AiThreadReplyJob = {
  kind: "thread_reply";
  channelId: string;
  messageId?: string;
  botUserId?: string;
  requesterUserId?: string;
  requesterUsername?: string;
  prompt: string;
  replyMessageId?: string;
  replyChannelId?: string;
};

export type AiChannelReplyJob = {
  kind: "channel_reply";
  channelId: string;
  messageId?: string;
  botUserId?: string;
  requesterUserId?: string;
  requesterUsername?: string;
  prompt: string;
  replyMessageId?: string;
  replyChannelId?: string;
};

export type AiJob = AiThreadStartJob | AiThreadReplyJob | AiChannelReplyJob;

export type AiSpendJob = {
  spendEventId: string;
};

export type AiThread = {
  threadId: string;
  parentChannelId?: string;
  sourceMessageId?: string;
  requesterUserId?: string;
  requesterUsername?: string;
  initialPrompt: string;
  title: string;
};

export type DiscordMessage = {
  id: string;
  guild_id?: string;
  channel_id: string;
  content?: string;
  author?: {
    id: string;
    username: string;
    global_name?: string | null;
    bot?: boolean;
  };
  member?: {
    nick?: string | null;
  };
  mentions?: Array<{ id: string; username?: string }>;
  mention_roles?: string[];
  attachments?: Array<{
    id: string;
    filename: string;
    content_type?: string;
    url?: string;
  }>;
  message_reference?: {
    channel_id?: string;
    message_id?: string;
  };
  referenced_message?: DiscordMessage | null;
};

export type DiscordChannel = {
  id: string;
  type: number;
  parent_id?: string | null;
  name?: string;
  thread_metadata?: Record<string, unknown>;
};

export type Env = Cloudflare.Env & {
  AI_JOBS: Queue<AiJob>;
  SPEND_JOBS?: Queue<AiSpendJob>;
  CLOUDFLARE_API_TOKEN?: string;
  CF_AIG_GATEWAY_ID?: string;
};

export const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

export const PING = 1;
export const APPLICATION_COMMAND = 2;
export const CHANNEL_MESSAGE_WITH_SOURCE = 4;
export const DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5;
