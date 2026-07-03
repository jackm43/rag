import type {
  AiJob,
  AiSpendJob,
  ConnectorInvokeJob,
  ConnectorOperation,
  DevProxyCommandJob,
  DevProxyCommandOption,
  ReplyJob,
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
const CONNECTOR_OPERATIONS: readonly ConnectorOperation[] = [
  "grant",
  "fetch",
  "token",
  "introspect",
  "begin_authorization",
  "complete_authorization",
];

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
// brain drops anything that resolves to an empty prompt.
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
  // A handle operation must carry a handle; a grant/authorization operation must
  // carry the connector it targets. Fail closed on the wrong locator.
  return usesHandle
    ? isString(value.handle) && value.connectorId === undefined
    : isString(value.connectorId);
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
