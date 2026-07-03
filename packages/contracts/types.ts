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

export type DevProxyCommandOption = { name: string; value: string };

// A slash-command invocation proxied by the dev-proxy worker. Encoded as a
// devproxy.command EventEnvelope and carried over the gateway's DevProxy
// service binding; the gateway rebuilds a synthetic Discord interaction from it
// and runs the ordinary command pre-flight. subjectUserId is the Discord user
// the command is authorized as (validated against DEV_PROXY_ALLOWED_SUBJECTS at
// the gateway before it is trusted).
export type DevProxyCommandJob = {
  kind: "devproxy.command";
  command: string;
  subjectUserId: string;
  subjectUsername?: string;
  guildId?: string;
  channelId?: string;
  applicationId?: string;
  interactionToken?: string;
  options: DevProxyCommandOption[];
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

// The result the gateway's DevProxy service-binding entrypoint returns to the
// dev-proxy worker: an HTTP-shaped triple the dev-proxy relays to the browser
// verbatim. It carries no internal detail on a denial (fail closed to a bare
// status), so the service boundary never leaks why a call was refused.
export type DevProxyResult = {
  status: number;
  contentType: string;
  body: string;
};

// Service-hop queue body: capnp-encoded ServiceMessage bytes (service.capnp)
// framing the EventEnvelope with the signed identity-context token (compact
// JWS) as a sibling Text field. The token is minted by the sending service
// and verified at the receiving boundary before Cedar runs; it binds a hash
// of the envelope bytes.
export type ServiceMessageBytes = Uint8Array;

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
  AI_JOBS: Queue<ServiceMessageBytes>;
  SPEND_JOBS?: Queue<ServiceMessageBytes>;
  DISCORD_OUTBOX?: Queue<ServiceMessageBytes>;
  RESPONDER?: {
    deliverInteractionEdit: (
      envelope: Uint8Array,
      attachment: ResponderAttachment,
      idToken: string,
    ) => Promise<void>;
  };
  // ServiceRegistry Durable Object (hosted by the gateway worker). Typed
  // structurally like RESPONDER so contracts does not import worker code.
  // Both RPC payloads are capnp bytes (service.capnp: ServiceManifest in,
  // ManifestSnapshot out).
  SERVICE_REGISTRY?: {
    idFromName: (name: string) => DurableObjectId;
    get: (id: DurableObjectId) => {
      register: (manifest: Uint8Array) => Promise<void>;
      snapshot: () => Promise<Uint8Array>;
    };
  };
  // Gateway DevProxy service-binding entrypoint, bound on the dev-proxy worker
  // ONLY (workers/public/dev-proxy). A service binding can be invoked solely by
  // a worker configured with it, so this RPC surface is reachable only from the
  // dev-proxy — the platform guarantee that gates the dev application's
  // strong-identity hop into the gateway. Typed structurally so contracts does
  // not import worker code (mirrors RESPONDER / SERVICE_REGISTRY).
  GATEWAY_DEVPROXY?: {
    invokeCommand: (message: ServiceMessageBytes) => Promise<DevProxyResult>;
  };
  // DPoP jti replay-cache Durable Object, bound on the dev-proxy worker only.
  // Strongly consistent (single-threaded) so the check-and-record is atomic.
  DPOP_REPLAY?: {
    idFromName: (name: string) => DurableObjectId;
    get: (id: DurableObjectId) => {
      seenBefore: (jti: string, ttlSeconds: number) => Promise<boolean>;
    };
  };
  // The Discord user the dev-proxy acts as, and the guild its commands target.
  // The gateway independently enforces DEV_PROXY_ALLOWED_SUBJECTS, so this is a
  // convenience default, not a trust boundary.
  DEV_PROXY_SUBJECT?: string;
  DEV_PROXY_GUILD?: string;
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
  // The dev-proxy worker's Ed25519 signing key (private JWK JSON). Held only by
  // workers/public/dev-proxy, which mints the on-behalf-of identity-context
  // token for each browser session's command hop into the gateway.
  DEV_PROXY_SIGNING_KEY?: string;
  // Dev-proxy ingress configuration (workers/public/dev-proxy). All are read
  // via env so nothing about the deployment's Access team or audience is baked
  // into code. See workers/public/dev-proxy/README notes and README.md.
  //   CF_ACCESS_TEAM_DOMAIN — e.g. "myteam.cloudflareaccess.com"; its
  //     /cdn-cgi/access/certs JWKS verifies the Access application token.
  //   CF_ACCESS_AUD — the Access application AUD tag (audience) the token must
  //     carry; a token minted for another Access app is refused.
  //   DEV_PROXY_ALLOWED_SUBJECTS — comma-separated Discord user ids the proxy
  //     may act as. A command whose acting subject is absent from this set is
  //     refused (fail closed): empty/unset denies all, so the proxy cannot be
  //     used to impersonate an arbitrary Discord user.
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  DEV_PROXY_ALLOWED_SUBJECTS?: string;
  // Workers KV holding the AI prompt/config files, bound on the brain worker
  // only (the sole runtime AI consumer). loadConfig reads it with a bundled
  // fallback, so it is optional — a fresh namespace or KV outage still works.
  AI_CONFIG?: KVNamespace;
};

export const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

export const MAX_DISCORD_MESSAGE_LENGTH = 1900;

export const PING = 1;
export const APPLICATION_COMMAND = 2;
export const CHANNEL_MESSAGE_WITH_SOURCE = 4;
export const DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5;
