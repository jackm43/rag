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

// The uniform operations the credential broker exposes. `grant` performs the
// token exchange (returns an opaque handle, never a credential); `fetch` uses a
// handle to have the broker make the outbound call; `token` extracts a real
// short-lived token for the rare must-call-directly case; `introspect` returns a
// handle's actor context (never a secret); `begin_authorization`/
// `complete_authorization` are the 3LO seam.
export type ConnectorOperation =
  | "grant"
  | "fetch"
  | "token"
  | "introspect"
  | "begin_authorization"
  | "complete_authorization";

// One operation against the credential broker, decoded from a connector.invoke
// EventEnvelope. `connectorId` is present on grant/authorization operations;
// `handle` on the handle-bearing operations (fetch/token/introspect). Operation-
// specific parameters ride as a JSON string in `paramsJson` (parsed and
// validated by the broker, never trusted as-is) so a new connector kind needs no
// wire-schema change.
export type ConnectorInvokeJob = {
  kind: "connector.invoke";
  operation: ConnectorOperation;
  connectorId?: string;
  handle?: string;
  subject?: string;
  scopes: string[];
  paramsJson: string;
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

// The credential broker's fail-closed result surface. Every operation returns a
// coarse HTTP-shaped `status` (200 ok, 401 unauthenticated, 403 forbidden, 404
// unknown handle/connector, 502 upstream failure, 500 internal) and, on success,
// exactly the one body field for the operation. A denial carries no detail — the
// broker logs the reason internally and never discloses which gate refused.
export type ConnectorGrantResult = {
  // The opaque phantom-token handle. High-entropy, bound to the caller principal
  // and subject; a leaked handle is useless to any other service.
  handle: string;
  connectorId: string;
  expiresAt: number;
};

export type ConnectorFetchResult = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export type ConnectorTokenResult = {
  // A real short-lived provider token, returned ONLY for the must-call-directly
  // escape hatch (connector.token). The preferred path is fetch, where the token
  // never leaves the broker.
  value: string;
  tokenType: string;
  expiresAt?: number;
};

export type ConnectorIntrospection = {
  active: boolean;
  connectorId: string;
  callerPrincipal: string;
  subject: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number;
};

export type ConnectorAuthorizationBegin = {
  url: string;
  state: string;
};

export type ConnectorResult = {
  status: number;
  grant?: ConnectorGrantResult;
  fetch?: ConnectorFetchResult;
  token?: ConnectorTokenResult;
  introspection?: ConnectorIntrospection;
  authorization?: ConnectorAuthorizationBegin;
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
  // The credential broker's service-binding entrypoint (workers/services/
  // connectors). Bound only on the workers permitted to use a connector — no
  // worker binds it in this task; a future caller (e.g. the brain) declares it.
  // A service binding is invocable solely by a worker configured with it, so this
  // RPC surface is reachable only from such a caller. Typed structurally so
  // contracts does not import worker code (mirrors RESPONDER / GATEWAY_DEVPROXY).
  CONNECTORS?: {
    invoke: (message: ServiceMessageBytes) => Promise<ConnectorResult>;
  };
  // The broker's own grant/token store, a Durable Object it defines and binds
  // (workers/services/connectors). Strongly consistent and persistent across
  // isolates, so a handle minted in one isolate resolves in another. Holds grant
  // entries (actor context + credential reference, never the secret) and, for
  // 3LO, per-(connector, subject) OAuth tokens. Typed structurally, like
  // SERVICE_REGISTRY.
  CONNECTOR_STORE?: {
    idFromName: (name: string) => DurableObjectId;
    get: (id: DurableObjectId) => {
      read: (key: string) => Promise<string | null>;
      write: (key: string, value: string, ttlMs?: number) => Promise<void>;
      remove: (key: string) => Promise<void>;
    };
  };
  // GitHub App connector secrets (workers/services/connectors). GITHUB_APP_ID is
  // the numeric App id (the JWT `iss`); GITHUB_APP_PRIVATE_KEY is the App's RSA
  // private key PEM (PKCS#8 or PKCS#1). Provisioned via `wrangler secret put`;
  // see CONNECTORS.md for the App-creation + installation steps.
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  // Optional application-level AES-GCM key (base64url of 32 bytes) for the 3LO
  // OAuth token store's values-at-rest. Durable Object storage is already
  // encrypted at rest by the platform; this adds envelope encryption for the
  // stored user refresh/access tokens where an operator wants defence in depth.
  CONNECTORS_TOKEN_ENC_KEY?: string;
  // The guild the dev-proxy's commands target. The acting Discord subject is no
  // longer an env default — it is the Discord id of the authenticated Better Auth
  // session (see workers/public/dev-proxy). The gateway independently enforces
  // DEV_PROXY_ALLOWED_SUBJECTS, so guild is a convenience default, not a trust
  // boundary.
  DEV_PROXY_GUILD?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CF_AIG_GATEWAY_ID?: string;
  GATEWAY_CONTROL_TOKEN?: string;
  // Production verifying keyring: JSON map of machine principal -> public JWK.
  // Overrides the committed default keyring in packages/identity/keyring.ts.
  // Public keys are not secret, so this is a plain var, not a secret.
  SERVICE_PUBLIC_KEYS?: string;
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
  // Dev-proxy application-identity layer (workers/public/dev-proxy). Better Auth
  // with Discord OAuth runs BEHIND Cloudflare Access: Access is the perimeter,
  // Better Auth resolves which Discord user is acting, and that Discord id
  // becomes the command's subject. Better Auth is authN only; Cedar stays authZ.
  //   AUTH_DB — the standalone `ragbot-auth` D1 database holding Better Auth's
  //     user/session/account/verification tables (kept apart from the gateway's
  //     operational DB). Passed to Better Auth directly (native D1 adapter).
  //   DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET — the Discord OAuth application
  //     credentials (secret, provisioned via `wrangler secret put`).
  //   BETTER_AUTH_SECRET — session/cookie signing secret (secret).
  //   BETTER_AUTH_URL — the public origin Access fronts (https://ragbot-dev…),
  //     from which Better Auth derives its OAuth callback and cookie domain.
  AUTH_DB?: D1Database;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
};

export const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

export const MAX_DISCORD_MESSAGE_LENGTH = 1900;

export const PING = 1;
export const APPLICATION_COMMAND = 2;
export const CHANNEL_MESSAGE_WITH_SOURCE = 4;
export const DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5;
