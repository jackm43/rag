@0x84bf4a759a05daf3;

# Event envelope for every message crossing a Cloudflare Queue.
# Regenerate the compiled module with `npm run contracts:build` (requires the
# native `capnp` compiler, e.g. `brew install capnp`).

struct ChatPayload {
  # thread_start / thread_reply / channel_reply / ask jobs.
  channelId @0 :Text;
  messageId @1 :Text;
  botUserId @2 :Text;
  prompt @3 :Text;
  replyMessageId @4 :Text;
  replyChannelId @5 :Text;
}

struct RagjamPayload {
  applicationId @0 :Text;
  interactionToken @1 :Text;
  channelId @2 :Text;
  prompt @3 :Text;
  lyrics @4 :Text;
}

struct BicturePayload {
  applicationId @0 :Text;
  interactionToken @1 :Text;
  channelId @2 :Text;
  prompt @3 :Text;
}

struct SpendPayload {
  spendEventId @0 :Text;
}

struct MessageReceivedPayload {
  messageId @0 :Text;
  channelId @1 :Text;
  botUserId @2 :Text;
  content @3 :Text;
  mentionUserIds @4 :List(Text);
  mentionRoleIds @5 :List(Text);
  replyMessageId @6 :Text;
  replyChannelId @7 :Text;
}

struct ChannelMessagePayload {
  channelId @0 :Text;
  content @1 :Text;
}

struct InteractionEditPayload {
  applicationId @0 :Text;
  interactionToken @1 :Text;
  content @2 :Text;
}

struct DevProxyCommandOption {
  # One slash-command option as a name/value pair. Values are carried as Text;
  # the command layer coerces them exactly as it does Discord option values.
  name @0 :Text;
  value @1 :Text;
}

struct DevProxyCommandPayload {
  # A command invocation proxied by the dev-proxy worker on behalf of a
  # Cloudflare Access + Better Auth (Discord) browser session. The gateway's DevProxy entrypoint
  # reconstructs a synthetic Discord interaction from this and runs the SAME
  # command pre-flight (Cedar command.* + limits + bans) a real interaction
  # would. `command` is the slash-command name (e.g. "ask"); subjectUserId is
  # the Discord user the command is authorized as.
  command @0 :Text;
  guildId @1 :Text;
  channelId @2 :Text;
  subjectUserId @3 :Text;
  subjectUsername @4 :Text;
  applicationId @5 :Text;
  interactionToken @6 :Text;
  options @7 :List(DevProxyCommandOption);
}

struct ConnectorInvokePayload {
  # A single operation against the credential broker (workers/services/connectors).
  # The uniform phantom-token model: `grant` exchanges the caller's authenticated
  # identity for an opaque handle (the real credential is prepared server-side and
  # never returned); `fetch`/`token`/`introspect` present that handle to use the
  # credential without ever receiving it. `operation` names which; `connectorId`
  # is set on `grant`/`begin_authorization`/`complete_authorization`; `handle` is
  # set on the handle-bearing operations. Operation-specific parameters (the
  # request for fetch, the code/state for a 3LO completion, installationId for a
  # github_app grant) ride as JSON in `paramsJson` so a new connector kind needs
  # no schema change — exactly as the identity token rides as an opaque JWS Text.
  operation @0 :Text;
  connectorId @1 :Text;
  handle @2 :Text;
  subject @3 :Text;
  scopes @4 :List(Text);
  paramsJson @5 :Text;
}

struct WebhookEventPayload {
  # A verified third-party webhook delivery, enqueued by the webhooks edge
  # worker (webhooks.jsmunro.me) AFTER the auth service's verifyWebhook confirmed
  # the provider signature over the exact body bytes. `connectorId` names the
  # connector whose secret verified it; `provider` is the signature scheme
  # ("github"); `eventId` is the provider event id
  # (GitHub's X-GitHub-Delivery) — present only when the
  # provider sent one; `eventType` is the provider's event name (e.g. GitHub's
  # X-GitHub-Event) when one travels in a header; `receivedAt` is the edge
  # receipt time (ISO 8601). The body rides base64 because the signature was
  # computed over exact bytes and the workflows worker may need to re-derive facts from
  # the same bytes.
  connectorId @0 :Text;
  provider @1 :Text;
  eventId @2 :Text;
  eventType @3 :Text;
  receivedAt @4 :Text;
  bodyBase64 @5 :Text;
}

struct EgressRequestPayload {
  # Generic application -> egress request. The caller signs this envelope with
  # its service identity; `profile` selects the egress worker's local policy
  # and credential injector. `headersJson` is a JSON object of caller-supplied
  # safe headers. The optional body travels as a sibling RPC argument, and
  # `bodySha256` binds those bytes to the signed envelope.
  profile @0 :Text;
  method @1 :Text;
  url @2 :Text;
  headersJson @3 :Text;
  bodySha256 @4 :Text;
}

struct ApplicationRequestPayload {
  # Generic generated-app request. Middleware clients validate app-facing HTTP
  # routes, the gateway signs this envelope, and a generated application service
  # server verifies the service boundary before dispatching to app code.
  applicationId @0 :Text;
  operationId @1 :Text;
  serviceOperation @2 :Text;
  method @3 :Text;
  url @4 :Text;
  headersJson @5 :Text;
  bodyBase64 @6 :Text;
  linkedTokenSha256 @7 :Text;
}

struct RegistryInvokePayload {
  # One HTTP-shaped control-plane operation against registry.jsmunro.me,
  # carried over the registry worker's own service-binding entrypoint. The
  # middleware client owns browser authentication; the service server verifies
  # the signed service hop, consumes request placement, runs Cedar service.invoke,
  # then dispatches the operation named here.
  operation @0 :Text;
  actorJson @1 :Text;
  bodyJson @2 :Text;
  targetId @3 :Text;
}

struct MetadataQueryPayload {
  # One GraphQL metadata resolver request accepted by metadata.jsmunro.me's
  # service server. The HTTP middleware authenticates the bearer token and
  # validates the outer GraphQL request shape; the service boundary verifies the
  # signed hop, placement, and Cedar service.invoke before executing resolvers.
  query @0 :Text;
  variablesJson @1 :Text;
  operationName @2 :Text;
}

struct AttestInvokePayload {
  # One HTTP-shaped GitHub webhook delivery accepted by attest.jsmunro.me's own
  # service-binding entrypoint. The middleware client owns the edge-level
  # method/size checks and collects only the small filtered GitHub signature
  # headers (x-hub-signature-256, x-github-delivery, x-github-event) into
  # headersJson; the service server verifies the signed service hop, then
  # verifies the GitHub signature via the connectors broker, dedupes, fetches
  # the commit tree, and records the attestation.
  operation @0 :Text;
  headersJson @1 :Text;
  bodyBase64 @2 :Text;
}

struct EventEnvelope {
  v @0 :UInt16;
  type @1 :Text;
  id @2 :Text;
  occurredAt @3 :Text;
  source @4 :Text;
  actor :group {
    userId @5 :Text;
    username @6 :Text;
  }
  guildId @7 :Text;
  payload :union {
    threadStart @8 :ChatPayload;
    threadReply @9 :ChatPayload;
    channelReply @10 :ChatPayload;
    ragjam @11 :RagjamPayload;
    spend @12 :SpendPayload;
    ask @13 :ChatPayload;
    bicture @14 :BicturePayload;
    replyChannelMessage @15 :ChannelMessagePayload;
    replyInteractionEdit @16 :InteractionEditPayload;
    messageReceived @17 :MessageReceivedPayload;
    devproxyCommand @18 :DevProxyCommandPayload;
    connectorInvoke @19 :ConnectorInvokePayload;
    webhookEvent @20 :WebhookEventPayload;
    egressRequest @21 :EgressRequestPayload;
    applicationRequest @22 :ApplicationRequestPayload;
    registryInvoke @23 :RegistryInvokePayload;
    metadataQuery @24 :MetadataQueryPayload;
    attestInvoke @25 :AttestInvokePayload;
  }
}
