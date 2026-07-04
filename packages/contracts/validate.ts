import type {
  AiJob,
  AiSpendJob,
  ApplicationRequestJob,
  AttestInvokeJob,
  AttestInvokeOperation,
  ConnectorInvokeJob,
  ConnectorOperation,
  DevProxyCommandJob,
  DevProxyCommandOption,
  EgressRequestJob,
  MetadataQueryJob,
  ReplyJob,
  RegistryInvokeJob,
  RegistryInvokeOperation,
  WebhookEventJob,
  WebhookEventProvider,
} from "./types";
import { isRecord } from "./validation";

// Value constraints the Cap'n Proto schema cannot express. Applied at encode
// (producer) and decode (consumer) time so neither side trusts the other hop.
export const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
export const MAX_FREE_TEXT_LENGTH = 4000;
export const MAX_USERNAME_LENGTH = 100;
export const MAX_INTERACTION_TOKEN_LENGTH = 2000;
export const MAX_SPEND_EVENT_ID_LENGTH = 128;
// A dev-proxy command names a slash command (lowercase identifier) and carries
// at most Discord's per-command option count, each a short name + capped value.
export const DEVPROXY_COMMAND_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const MAX_DEVPROXY_OPTIONS = 25;
export const MAX_DEVPROXY_OPTION_NAME_LENGTH = 32;
// Raw model text crossing the outbox before the responder applies the final
// Discord length policy. Queue messages are capped at 128 KiB, so keep this
// far below that even at four bytes per character.
export const MAX_REPLY_CONTENT_LENGTH = 16_000;
// Discord messages carry at most ~100 user/role mentions.
export const MAX_MENTION_IDS = 100;

// Credential-broker envelope constraints. A connector id is a short lowercase
// slug; an opaque handle is a high-entropy url-safe string; params is a JSON
// blob capped well below the 128 KiB framed-message ceiling so an
// authorizedFetch body still fits. Scopes are a small bounded list.
export const CONNECTOR_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const CONNECTOR_HANDLE_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
export const MAX_CONNECTOR_SUBJECT_LENGTH = 200;
export const MAX_CONNECTOR_SCOPES = 50;
export const MAX_CONNECTOR_SCOPE_LENGTH = 200;
export const MAX_CONNECTOR_PARAMS_LENGTH = 96 * 1024;
// Webhook-event envelope constraints. The raw body is capped well below the
// 128 KiB framed-message ceiling so the envelope (base64 body + metadata +
// the wrapping ServiceMessage) always fits a queue message; the receiver
// enforces the same raw-byte cap at ingress before base64ing. Event ids and
// types are short provider identifiers (a GitHub delivery GUID, a Stripe
// `evt_…` id, an event name), not free text.
export const WEBHOOK_PROVIDERS: readonly WebhookEventProvider[] = ["github", "stripe"];
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
// Base64 expansion of the raw-byte cap: 4 output chars per 3 input bytes.
export const MAX_WEBHOOK_BODY_BASE64_LENGTH = Math.ceil(MAX_WEBHOOK_BODY_BYTES / 3) * 4;
export const MAX_WEBHOOK_EVENT_ID_LENGTH = 200;
export const MAX_WEBHOOK_EVENT_TYPE_LENGTH = 100;
export const EGRESS_PROFILE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const MAX_EGRESS_URL_LENGTH = 4096;
export const MAX_EGRESS_HEADERS_JSON_LENGTH = 16 * 1024;
export const MAX_EGRESS_BODY_BYTES = 25 * 1024 * 1024;
export const MAX_EGRESS_BODY_SHA256_LENGTH = 64;
export const APPLICATION_ID_PATTERN = /^[a-z][a-z0-9-]{2,63}$/;
export const APPLICATION_OPERATION_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;
export const MAX_APPLICATION_URL_LENGTH = 4096;
export const MAX_APPLICATION_HEADERS_JSON_LENGTH = 16 * 1024;
export const MAX_APPLICATION_BODY_BYTES = 64 * 1024;
export const MAX_APPLICATION_BODY_BASE64_LENGTH = Math.ceil(MAX_APPLICATION_BODY_BYTES / 3) * 4;
export const APPLICATION_LINKED_TOKEN_SHA256_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const MAX_REGISTRY_ACTOR_JSON_LENGTH = 2048;
export const MAX_REGISTRY_BODY_JSON_LENGTH = 96 * 1024;
export const MAX_METADATA_QUERY_LENGTH = 16 * 1024;
export const MAX_METADATA_VARIABLES_JSON_LENGTH = 32 * 1024;
export const MAX_METADATA_OPERATION_NAME_LENGTH = 128;
const EGRESS_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;
const APPLICATION_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
const BASE64URL_SHA256_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

const CONNECTOR_OPERATIONS: readonly ConnectorOperation[] = [
  "grant",
  "fetch",
  "token",
  "introspect",
  "begin_authorization",
  "complete_authorization",
  "webhook_verify",
  "admin_list",
  "admin_describe",
  "admin_set_secret",
  "admin_set_capabilities",
  "admin_providers",
  "admin_installations",
];

export const REGISTRY_INVOKE_OPERATIONS: readonly RegistryInvokeOperation[] = [
  "application.list",
  "application.create",
  "application.get",
  "application.update",
  "application.delete",
  "application.attestations.verify",
];

export const ATTEST_INVOKE_OPERATIONS: readonly AttestInvokeOperation[] = ["webhook.github"];
// headersJson carries only the small filtered GitHub signature headers
// (x-hub-signature-256, x-github-delivery, x-github-event), so it is capped
// far below the general egress/application headersJson caps.
export const MAX_ATTEST_HEADERS_JSON_LENGTH = 2 * 1024;

const isString = (value: unknown): value is string => typeof value === "string";

export const isSnowflake = (value: unknown): value is string =>
  isString(value) && SNOWFLAKE_PATTERN.test(value);

export const isOptionalSnowflake = (value: unknown) => value === undefined || isSnowflake(value);

const isFreeText = (value: unknown): value is string =>
  isString(value) && value.length > 0 && value.length <= MAX_FREE_TEXT_LENGTH;

const isOptionalFreeText = (value: unknown) => value === undefined || isFreeText(value);

const isUsername = (value: unknown): value is string =>
  isString(value) && value.length > 0 && value.length <= MAX_USERNAME_LENGTH;

const isOptionalUsername = (value: unknown) => value === undefined || isUsername(value);

const isInteractionToken = (value: unknown): value is string =>
  isString(value) && value.length > 0 && value.length <= MAX_INTERACTION_TOKEN_LENGTH;

// Gateway message content may be empty (e.g. attachment-only messages); the
// workflows drops anything that resolves to an empty prompt.
const isCappedText = (value: unknown): value is string =>
  isString(value) && value.length <= MAX_FREE_TEXT_LENGTH;

const isSnowflakeList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= MAX_MENTION_IDS && value.every(isSnowflake);

export const validateAiJob = (value: unknown): value is AiJob => {
  if (
    !isRecord(value) ||
    (
      value.kind !== "thread_start" &&
      value.kind !== "thread_reply" &&
      value.kind !== "channel_reply" &&
      value.kind !== "ask" &&
      value.kind !== "ragjam" &&
      value.kind !== "bicture" &&
      value.kind !== "message.received"
    )
  ) {
    return false;
  }

  if (value.kind === "message.received") {
    return (
      isSnowflake(value.messageId) &&
      isSnowflake(value.channelId) &&
      isSnowflake(value.botUserId) &&
      isOptionalSnowflake(value.guildId) &&
      isOptionalSnowflake(value.authorId) &&
      isOptionalUsername(value.authorUsername) &&
      isCappedText(value.content) &&
      isSnowflakeList(value.mentionUserIds) &&
      isSnowflakeList(value.mentionRoleIds) &&
      isOptionalSnowflake(value.replyMessageId) &&
      isOptionalSnowflake(value.replyChannelId)
    );
  }

  if (value.kind === "bicture") {
    return (
      isSnowflake(value.applicationId) &&
      isInteractionToken(value.interactionToken) &&
      isFreeText(value.prompt) &&
      isOptionalSnowflake(value.channelId) &&
      isOptionalSnowflake(value.requesterUserId) &&
      isOptionalUsername(value.requesterUsername)
    );
  }

  if (value.kind === "ragjam") {
    return (
      isSnowflake(value.applicationId) &&
      isInteractionToken(value.interactionToken) &&
      isFreeText(value.prompt) &&
      isOptionalSnowflake(value.channelId) &&
      isOptionalSnowflake(value.requesterUserId) &&
      isOptionalUsername(value.requesterUsername) &&
      isOptionalFreeText(value.lyrics)
    );
  }

  const common =
    isSnowflake(value.channelId) &&
    isFreeText(value.prompt) &&
    isOptionalSnowflake(value.botUserId) &&
    isOptionalSnowflake(value.requesterUserId) &&
    isOptionalUsername(value.requesterUsername) &&
    isOptionalSnowflake(value.replyMessageId) &&
    isOptionalSnowflake(value.replyChannelId);

  if (!common) {
    return false;
  }

  if (value.kind === "thread_start") {
    return isSnowflake(value.messageId);
  }

  return isOptionalSnowflake(value.messageId);
};

// Reply content may be empty: the responder substitutes its own fallback text.
const isReplyContent = (value: unknown): value is string =>
  isString(value) && value.length <= MAX_REPLY_CONTENT_LENGTH;

export const validateReplyJob = (value: unknown): value is ReplyJob => {
  if (!isRecord(value)) {
    return false;
  }

  if (value.kind === "reply.channel_message") {
    return isSnowflake(value.channelId) && isReplyContent(value.content);
  }

  if (value.kind === "reply.interaction_edit") {
    return (
      isSnowflake(value.applicationId) &&
      isInteractionToken(value.interactionToken) &&
      isReplyContent(value.content)
    );
  }

  return false;
};

const isConnectorScopes = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= MAX_CONNECTOR_SCOPES &&
  value.every(
    (scope) => isString(scope) && scope.length > 0 && scope.length <= MAX_CONNECTOR_SCOPE_LENGTH,
  );

// Wire-shape validation only: the operation is a known verb, the ids/handle
// match their character classes and caps, and exactly the right locator is
// present (a connectorId for grant/authorization, a handle for the handle-
// bearing operations). The broker parses and validates paramsJson semantically;
// here it is only length-bounded so a hostile payload cannot bloat the message.
export const validateConnectorInvokeJob = (value: unknown): value is ConnectorInvokeJob => {
  if (
    !isRecord(value) ||
    value.kind !== "connector.invoke" ||
    !isString(value.operation) ||
    !CONNECTOR_OPERATIONS.includes(value.operation as ConnectorOperation) ||
    !isString(value.paramsJson) ||
    value.paramsJson.length > MAX_CONNECTOR_PARAMS_LENGTH ||
    !isConnectorScopes(value.scopes) ||
    (value.subject !== undefined &&
      (!isString(value.subject) || value.subject.length > MAX_CONNECTOR_SUBJECT_LENGTH)) ||
    (value.connectorId !== undefined &&
      (!isString(value.connectorId) || !CONNECTOR_ID_PATTERN.test(value.connectorId))) ||
    (value.handle !== undefined &&
      (!isString(value.handle) || !CONNECTOR_HANDLE_PATTERN.test(value.handle)))
  ) {
    return false;
  }
  const operation = value.operation as ConnectorOperation;
  const usesHandle =
    operation === "fetch" || operation === "token" || operation === "introspect";
  // Broker-wide admin ops (list every connector, list the secrets backends) name
  // no single connector and bear no handle. They must carry neither locator.
  const brokerWide = operation === "admin_list" || operation === "admin_providers";
  if (brokerWide) {
    return value.connectorId === undefined && value.handle === undefined;
  }
  // A handle operation must carry a handle; every other operation (grant,
  // authorization, webhook_verify, and the per-connector admin ops
  // describe/set_secret/installations) must carry the connector it targets.
  // Fail closed on the wrong locator.
  return usesHandle
    ? isString(value.handle) && value.connectorId === undefined
    : isString(value.connectorId);
};

// Wire-shape validation for a verified webhook event: the connector id and
// provider match their vocabularies, the ids/type are capped provider
// identifiers, receivedAt is a real timestamp, and the body is well-formed
// base64 within the raw-byte cap. Applied at encode (the webhooks worker) and
// decode (the workflows worker) so neither side trusts the queue hop. The body's CONTENT
// is deliberately not inspected here — the signature was verified broker-side
// and the consumer parses it under its own rules.
export const validateWebhookEventJob = (value: unknown): value is WebhookEventJob =>
  isRecord(value) &&
  value.kind === "webhook.event" &&
  isString(value.connectorId) &&
  CONNECTOR_ID_PATTERN.test(value.connectorId) &&
  WEBHOOK_PROVIDERS.includes(value.provider as WebhookEventProvider) &&
  (value.eventId === undefined ||
    (isString(value.eventId) &&
      value.eventId.length > 0 &&
      value.eventId.length <= MAX_WEBHOOK_EVENT_ID_LENGTH)) &&
  (value.eventType === undefined ||
    (isString(value.eventType) &&
      value.eventType.length > 0 &&
      value.eventType.length <= MAX_WEBHOOK_EVENT_TYPE_LENGTH)) &&
  isString(value.receivedAt) &&
  value.receivedAt.length <= 40 &&
  !Number.isNaN(Date.parse(value.receivedAt)) &&
  isString(value.bodyBase64) &&
  value.bodyBase64.length <= MAX_WEBHOOK_BODY_BASE64_LENGTH &&
  value.bodyBase64.length % 4 === 0 &&
  BASE64_PATTERN.test(value.bodyBase64);

export const validateEgressRequestJob = (value: unknown): value is EgressRequestJob => {
  if (
    !isRecord(value) ||
    value.kind !== "egress.request" ||
    !isString(value.profile) ||
    !EGRESS_PROFILE_PATTERN.test(value.profile) ||
    !isString(value.method) ||
    !EGRESS_METHODS.includes(value.method.toUpperCase() as typeof EGRESS_METHODS[number]) ||
    value.method !== value.method.toUpperCase() ||
    !isString(value.url) ||
    value.url.length === 0 ||
    value.url.length > MAX_EGRESS_URL_LENGTH ||
    !isString(value.headersJson) ||
    value.headersJson.length > MAX_EGRESS_HEADERS_JSON_LENGTH ||
    (value.bodySha256 !== undefined &&
      (!isString(value.bodySha256) || !BASE64URL_SHA256_PATTERN.test(value.bodySha256)))
  ) {
    return false;
  }

  try {
    const url = new URL(value.url);
    if (url.protocol !== "https:") {
      return false;
    }
    const headers = JSON.parse(value.headersJson) as unknown;
    return (
      isRecord(headers) &&
      Object.entries(headers).every(
        ([key, headerValue]) =>
          /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key) &&
          isString(headerValue) &&
          headerValue.length <= 8192,
      )
    );
  } catch {
    return false;
  }
};

export const validateApplicationRequestJob = (value: unknown): value is ApplicationRequestJob => {
  if (
    !isRecord(value) ||
    value.kind !== "application.request" ||
    !isString(value.applicationId) ||
    !APPLICATION_ID_PATTERN.test(value.applicationId) ||
    !isString(value.operationId) ||
    !APPLICATION_OPERATION_PATTERN.test(value.operationId) ||
    !isString(value.serviceOperation) ||
    !APPLICATION_OPERATION_PATTERN.test(value.serviceOperation) ||
    !isString(value.method) ||
    !APPLICATION_METHODS.includes(value.method.toUpperCase() as typeof APPLICATION_METHODS[number]) ||
    value.method !== value.method.toUpperCase() ||
    !isString(value.url) ||
    value.url.length === 0 ||
    value.url.length > MAX_APPLICATION_URL_LENGTH ||
    !isString(value.headersJson) ||
    value.headersJson.length > MAX_APPLICATION_HEADERS_JSON_LENGTH ||
    !isString(value.bodyBase64) ||
    value.bodyBase64.length > MAX_APPLICATION_BODY_BASE64_LENGTH ||
    value.bodyBase64.length % 4 !== 0 ||
    !BASE64_PATTERN.test(value.bodyBase64) ||
    !isString(value.linkedTokenSha256) ||
    !APPLICATION_LINKED_TOKEN_SHA256_PATTERN.test(value.linkedTokenSha256)
  ) {
    return false;
  }

  try {
    const url = new URL(value.url);
    const headers = JSON.parse(value.headersJson) as unknown;
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      isRecord(headers) &&
      Object.entries(headers).every(
        ([key, headerValue]) =>
          /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key) &&
          isString(headerValue) &&
          headerValue.length <= 8192,
      )
    );
  } catch {
    return false;
  }
};

const isJsonRecord = (value: string): boolean => {
  try {
    return isRecord(JSON.parse(value) as unknown);
  } catch {
    return false;
  }
};

export const validateRegistryInvokeJob = (value: unknown): value is RegistryInvokeJob => {
  if (
    !isRecord(value) ||
    value.kind !== "registry.invoke" ||
    !isString(value.operation) ||
    !REGISTRY_INVOKE_OPERATIONS.includes(value.operation as RegistryInvokeOperation) ||
    !isString(value.actorJson) ||
    value.actorJson.length === 0 ||
    value.actorJson.length > MAX_REGISTRY_ACTOR_JSON_LENGTH ||
    !isJsonRecord(value.actorJson) ||
    !isString(value.bodyJson) ||
    value.bodyJson.length === 0 ||
    value.bodyJson.length > MAX_REGISTRY_BODY_JSON_LENGTH ||
    !isJsonRecord(value.bodyJson) ||
    (value.targetId !== undefined &&
      (!isString(value.targetId) || !APPLICATION_ID_PATTERN.test(value.targetId)))
  ) {
    return false;
  }

  const operation = value.operation as RegistryInvokeOperation;
  const requiresTarget =
    operation === "application.get" ||
    operation === "application.update" ||
    operation === "application.delete" ||
    operation === "application.attestations.verify";
  return requiresTarget ? value.targetId !== undefined : value.targetId === undefined;
};

// The only GitHub webhook headers the middleware client is allowed to forward
// into headersJson. Anything else (including the raw request's other
// headers) must never reach the envelope — the service server verifies the
// signature via the connectors broker using exactly these.
export const ATTEST_WEBHOOK_SIGNATURE_HEADERS = [
  "x-hub-signature-256",
  "x-github-delivery",
  "x-github-event",
] as const;

export const validateAttestInvokeJob = (value: unknown): value is AttestInvokeJob => {
  if (
    !isRecord(value) ||
    value.kind !== "attest.invoke" ||
    !isString(value.operation) ||
    !ATTEST_INVOKE_OPERATIONS.includes(value.operation as AttestInvokeOperation) ||
    !isString(value.headersJson) ||
    value.headersJson.length > MAX_ATTEST_HEADERS_JSON_LENGTH ||
    !isString(value.bodyBase64) ||
    value.bodyBase64.length > MAX_WEBHOOK_BODY_BASE64_LENGTH ||
    value.bodyBase64.length % 4 !== 0 ||
    !BASE64_PATTERN.test(value.bodyBase64)
  ) {
    return false;
  }
  try {
    const headers = JSON.parse(value.headersJson) as unknown;
    return (
      isRecord(headers) &&
      Object.entries(headers).every(
        ([key, headerValue]) =>
          (ATTEST_WEBHOOK_SIGNATURE_HEADERS as readonly string[]).includes(key) &&
          isString(headerValue) &&
          headerValue.length <= 8192,
      )
    );
  } catch {
    return false;
  }
};

export const validateMetadataQueryJob = (value: unknown): value is MetadataQueryJob => {
  if (
    !isRecord(value) ||
    value.kind !== "metadata.query" ||
    !isString(value.query) ||
    value.query.length === 0 ||
    value.query.length > MAX_METADATA_QUERY_LENGTH ||
    !isString(value.variablesJson) ||
    value.variablesJson.length === 0 ||
    value.variablesJson.length > MAX_METADATA_VARIABLES_JSON_LENGTH ||
    (value.operationName !== undefined &&
      (!isString(value.operationName) ||
        value.operationName.length === 0 ||
        value.operationName.length > MAX_METADATA_OPERATION_NAME_LENGTH))
  ) {
    return false;
  }
  try {
    return isRecord(JSON.parse(value.variablesJson) as unknown);
  } catch {
    return false;
  }
};

export const validateAiSpendJob = (value: unknown): value is AiSpendJob =>
  isRecord(value) &&
  isString(value.spendEventId) &&
  value.spendEventId.length > 0 &&
  value.spendEventId.length <= MAX_SPEND_EVENT_ID_LENGTH;

const isDevProxyOption = (value: unknown): value is DevProxyCommandOption =>
  isRecord(value) &&
  isString(value.name) &&
  value.name.length > 0 &&
  value.name.length <= MAX_DEVPROXY_OPTION_NAME_LENGTH &&
  isCappedText(value.value);

const isDevProxyOptionList = (value: unknown): value is DevProxyCommandOption[] =>
  Array.isArray(value) && value.length <= MAX_DEVPROXY_OPTIONS && value.every(isDevProxyOption);

export const validateDevProxyCommandJob = (value: unknown): value is DevProxyCommandJob =>
  isRecord(value) &&
  value.kind === "devproxy.command" &&
  isString(value.command) &&
  DEVPROXY_COMMAND_PATTERN.test(value.command) &&
  // The acting Discord subject is mandatory and must be a real snowflake; the
  // gateway further constrains it to DEV_PROXY_ALLOWED_SUBJECTS.
  isSnowflake(value.subjectUserId) &&
  isOptionalUsername(value.subjectUsername) &&
  isOptionalSnowflake(value.guildId) &&
  isOptionalSnowflake(value.channelId) &&
  isOptionalSnowflake(value.applicationId) &&
  (value.interactionToken === undefined || isInteractionToken(value.interactionToken)) &&
  isDevProxyOptionList(value.options);
