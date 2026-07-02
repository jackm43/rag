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

export type AiAskJob = {
  kind: "ask";
  channelId: string;
  messageId?: string;
  botUserId?: string;
  requesterUserId?: string;
  requesterUsername?: string;
  prompt: string;
  replyMessageId?: string;
  replyChannelId?: string;
};

export type RagjamJob = {
  kind: "ragjam";
  applicationId: string;
  interactionToken: string;
  channelId?: string;
  requesterUserId?: string;
  requesterUsername?: string;
  prompt: string;
  lyrics?: string;
};

// A raw-but-validated gateway MESSAGE_CREATE, encoded by the Durable Object
// with no D1 or Discord REST access. The brain worker resolves it into a
// thread_reply/channel_reply (or drops it) in-process.
export type MessageReceivedJob = {
  kind: "message.received";
  messageId: string;
  channelId: string;
  guildId?: string;
  botUserId: string;
  authorId?: string;
  authorUsername?: string;
  content: string;
  mentionUserIds: string[];
  mentionRoleIds: string[];
  replyMessageId?: string;
  replyChannelId?: string;
};

export type BictureJob = {
  kind: "bicture";
  applicationId: string;
  interactionToken: string;
  channelId?: string;
  requesterUserId?: string;
  requesterUsername?: string;
  prompt: string;
};

export type AiChatJob = AiThreadStartJob | AiThreadReplyJob | AiChannelReplyJob;

export type AiJob = AiChatJob | AiAskJob | RagjamJob | BictureJob | MessageReceivedJob;

export type AiSpendJob = {
  spendEventId: string;
};

export type ChannelMessageReplyJob = {
  kind: "reply.channel_message";
  channelId: string;
  content: string;
};

export type InteractionEditReplyJob = {
  kind: "reply.interaction_edit";
  applicationId: string;
  interactionToken: string;
  content: string;
};

export type ReplyJob = ChannelMessageReplyJob | InteractionEditReplyJob;

export type ResponderAttachment = {
  name: string;
  contentType: string;
  data: ArrayBuffer;
};

// Peer-hop queue message: the Cap'n Proto envelope bytes are carried unchanged,
// with the signed identity-context token (compact JWS) as a sibling field. The
// token is minted by the sending worker and verified at the receiving boundary
// before Cedar runs; keeping it out of the capnp envelope means the contract
// wire format is untouched and the token binds a hash of `envelope`.
export type PeerQueueMessage = {
  envelope: Uint8Array;
  idToken: string;
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
  AI_JOBS: Queue<PeerQueueMessage>;
  SPEND_JOBS?: Queue<PeerQueueMessage>;
  DISCORD_OUTBOX?: Queue<PeerQueueMessage>;
  RESPONDER?: {
    deliverInteractionEdit: (
      envelope: Uint8Array,
      attachment: ResponderAttachment,
      idToken: string,
    ) => Promise<void>;
  };
  CLOUDFLARE_API_TOKEN?: string;
  CF_AIG_GATEWAY_ID?: string;
  GATEWAY_CONTROL_TOKEN?: string;
  ALLOWED_GUILD_IDS?: string;
  AI_BURST_LIMIT_PER_MINUTE?: string;
  AI_GLOBAL_DAILY_BUDGET_USD?: string;
  // Per-worker Ed25519 signing keys (private JWK JSON), provisioned as secrets.
  // Only the sending workers hold one: the gateway mints origin contexts, the
  // brain re-mints on-behalf-of tokens for its downstream hops. Receivers read
  // public keys from the committed keyring, not these.
  GATEWAY_SIGNING_KEY?: string;
  BRAIN_SIGNING_KEY?: string;
};

export const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

export const MAX_DISCORD_MESSAGE_LENGTH = 1900;

export const PING = 1;
export const APPLICATION_COMMAND = 2;
export const CHANNEL_MESSAGE_WITH_SOURCE = 4;
export const DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5;
