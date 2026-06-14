export type DiscordInteraction = {
  application_id?: string;
  token?: string;
  type: number;
  guild_id?: string | null;
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

export type ChannelPromptSource = "mention" | "reply";

export type AiChannelJob = {
  kind: "channel" | "rpc";
  channelId: string;
  messageId?: string;
  botUserId?: string;
  requesterUserId?: string;
  requesterUsername?: string;
  prompt: string;
  promptSource?: ChannelPromptSource;
  replyMessageId?: string;
  replyContext?: string;
};

export type AiJob = AiChannelJob;

export type DiscordMessage = {
  id: string;
  channel_id: string;
  guild_id?: string | null;
  content?: string;
  author?: {
    id: string;
    username: string;
    bot?: boolean;
  };
  mentions?: Array<{
    id: string;
    username?: string;
  }>;
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

import type { WorkerSecret } from "@platy/sdk";

export interface Env {
  ASSETS: Fetcher;
  DISCORD_PUBLIC_KEY: WorkerSecret;
  DISCORD_APPLICATION_ID: WorkerSecret;
  DISCORD_BOT_TOKEN: WorkerSecret;
  AUTH_GATEWAY_URL?: string;
  AUTH_GATEWAY?: Fetcher;
  AIGATEWAY_ENDPOINT?: string;
  AIGATEWAY?: Fetcher;
  DEPLOY_ENDPOINT?: string;
  DEPLOY?: Fetcher;
  RAGBOT_ENDPOINT?: string;
  RAGBOT?: Fetcher;
  ALLOWED_GUILD_IDS?: string;
  SERVICE_CLIENT_ID?: string;
  SERVICE_CLIENT_SECRET?: WorkerSecret;
  // OTEL: service name override and optional OTLP/HTTP export target.
  OTEL_SERVICE_NAME?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
  DISCORD_GATEWAY: DurableObjectNamespace;
  DB: D1Database;
  AI_JOBS: Queue<AiJob>;
}

export const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

export const PING = 1;
export const APPLICATION_COMMAND = 2;
export const CHANNEL_MESSAGE_WITH_SOURCE = 4;
export const DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5;
