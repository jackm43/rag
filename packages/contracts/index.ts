import * as capnp from "capnp-es";
import type {
  AiAskJob,
  AiChatJob,
  AiJob,
  AiSpendJob,
  ApplicationRequestJob,
  AttestInvokeJob,
  BictureJob,
  ConnectorInvokeJob,
  DevProxyCommandJob,
  DevProxyCommandOption,
  EgressRequestJob,
  MetadataQueryJob,
  MessageReceivedJob,
  RagjamJob,
  ReplyJob,
  RegistryInvokeJob,
  WebhookEventJob,
  WebhookEventProvider,
} from "./types";
import {
  ApplicationRequestPayload,
  AttestInvokePayload,
  ChatPayload,
  ConnectorInvokePayload,
  DevProxyCommandPayload,
  EgressRequestPayload,
  EventEnvelope,
  EventEnvelope_Payload_Which,
  MetadataQueryPayload,
  RegistryInvokePayload,
  WebhookEventPayload,
} from "./envelope";
import { asFramedBytes } from "./framing";
import {
  isOptionalSnowflake,
  validateAiJob,
  validateAiSpendJob,
  validateApplicationRequestJob,
  validateAttestInvokeJob,
  validateConnectorInvokeJob,
  validateDevProxyCommandJob,
  validateEgressRequestJob,
  validateMetadataQueryJob,
  validateReplyJob,
  validateRegistryInvokeJob,
  validateWebhookEventJob,
} from "./validate";

export {
  decodeManifestSnapshot,
  decodeServiceManifest,
  decodeServiceMessage,
  encodeManifestSnapshot,
  encodeServiceManifest,
  encodeServiceMessage,
  type WireServiceManifest,
  type WireServiceMessage,
} from "./service-transport";

export type { ApplicationRequestJob, PreparedApplicationRequest } from "./types";

export {
  ATTEST_WEBHOOK_SIGNATURE_HEADERS,
  CONNECTOR_HANDLE_PATTERN,
  CONNECTOR_ID_PATTERN,
  DEVPROXY_COMMAND_PATTERN,
  EGRESS_PROFILE_PATTERN,
  APPLICATION_ID_PATTERN,
  APPLICATION_LINKED_TOKEN_SHA256_PATTERN,
  APPLICATION_OPERATION_PATTERN,
  isSnowflake,
  MAX_APPLICATION_BODY_BASE64_LENGTH,
  MAX_APPLICATION_BODY_BYTES,
  MAX_APPLICATION_HEADERS_JSON_LENGTH,
  MAX_APPLICATION_URL_LENGTH,
  MAX_ATTEST_HEADERS_JSON_LENGTH,
  MAX_CONNECTOR_PARAMS_LENGTH,
  MAX_CONNECTOR_SCOPE_LENGTH,
  MAX_CONNECTOR_SCOPES,
  MAX_CONNECTOR_SUBJECT_LENGTH,
  MAX_DEVPROXY_OPTION_NAME_LENGTH,
  MAX_DEVPROXY_OPTIONS,
  MAX_EGRESS_BODY_BYTES,
  MAX_EGRESS_BODY_SHA256_LENGTH,
  MAX_EGRESS_HEADERS_JSON_LENGTH,
  MAX_EGRESS_URL_LENGTH,
  MAX_FREE_TEXT_LENGTH,
  MAX_INTERACTION_TOKEN_LENGTH,
  MAX_MENTION_IDS,
  MAX_METADATA_OPERATION_NAME_LENGTH,
  MAX_METADATA_QUERY_LENGTH,
  MAX_METADATA_VARIABLES_JSON_LENGTH,
  MAX_REPLY_CONTENT_LENGTH,
  MAX_REGISTRY_ACTOR_JSON_LENGTH,
  MAX_REGISTRY_BODY_JSON_LENGTH,
  MAX_SPEND_EVENT_ID_LENGTH,
  MAX_USERNAME_LENGTH,
  MAX_WEBHOOK_BODY_BASE64_LENGTH,
  MAX_WEBHOOK_BODY_BYTES,
  MAX_WEBHOOK_EVENT_ID_LENGTH,
  MAX_WEBHOOK_EVENT_TYPE_LENGTH,
  SNOWFLAKE_PATTERN,
  validateAiJob,
  validateAiSpendJob,
  validateApplicationRequestJob,
  validateAttestInvokeJob,
  validateConnectorInvokeJob,
  validateDevProxyCommandJob,
  validateEgressRequestJob,
  validateMetadataQueryJob,
  validateReplyJob,
  validateRegistryInvokeJob,
  validateWebhookEventJob,
  WEBHOOK_PROVIDERS,
} from "./validate";

export const ENVELOPE_VERSION = 1;

export type EventSource = "interactions" | "gateway" | "worker";

export type EnvelopeOptions = {
  source: EventSource;
  guildId?: string;
};

const SPEND_EVENT_TYPE = "spend";
// The envelope `type` for a proxied dev-proxy command. Mirrors
// DEVPROXY_COMMAND_OPERATION in packages/auth/principal.ts (the gateway's
// registered service operation) — kept as a literal here to avoid a
// contracts→auth import cycle, exactly like SPEND_EVENT_TYPE mirrors the
// spend service operation.
const DEVPROXY_COMMAND_TYPE = "devproxy.command";
// The envelope `type` for a credential-broker operation. Mirrors
// CONNECTOR_INVOKE_OPERATION in packages/auth/principal.ts (the broker's single
// registered service operation) — kept as a literal here to avoid a
// contracts→auth import cycle, like SPEND_EVENT_TYPE and DEVPROXY_COMMAND_TYPE.
const CONNECTOR_INVOKE_TYPE = "connector.invoke";
// The envelope `type` for a verified webhook event (the webhooks worker's
// enqueue to the workflows worker). Mirrors the entry in SERVICE_OPERATIONS.workflows
// (packages/auth/principal.ts) — a literal here for the same no-cycle reason.
const WEBHOOK_EVENT_TYPE = "webhook.event";
const EGRESS_REQUEST_TYPE = "egress.request";
const APPLICATION_REQUEST_TYPE = "application.request";
const REGISTRY_INVOKE_TYPE = "registry.invoke";
const METADATA_QUERY_TYPE = "metadata.query";
const ATTEST_INVOKE_TYPE = "attest.invoke";

type ChatLikeKind = AiChatJob["kind"] | AiAskJob["kind"];

const CHAT_PAYLOAD_WHICH: Record<ChatLikeKind, EventEnvelope_Payload_Which> = {
  thread_start: EventEnvelope_Payload_Which.THREAD_START,
  thread_reply: EventEnvelope_Payload_Which.THREAD_REPLY,
  channel_reply: EventEnvelope_Payload_Which.CHANNEL_REPLY,
  ask: EventEnvelope_Payload_Which.ASK,
};

const optionalText = (value: string) => (value.length > 0 ? value : undefined);

const textListToArray = (list: capnp.List<string>): string[] =>
  Array.from({ length: list.length }, (_, index) => list.get(index));

const compact = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;

const initEnvelope = (
  message: capnp.Message,
  type: string,
  options: EnvelopeOptions,
  actor: { userId?: string; username?: string } = {},
) => {
  if (!isOptionalSnowflake(options.guildId)) {
    throw new Error("Invalid guild id for event envelope");
  }
  const envelope = message.initRoot(EventEnvelope);
  envelope.v = ENVELOPE_VERSION;
  envelope.type = type;
  envelope.id = crypto.randomUUID();
  envelope.occurredAt = new Date().toISOString();
  envelope.source = options.source;
  if (options.guildId !== undefined) {
    envelope.guildId = options.guildId;
  }
  if (actor.userId !== undefined) {
    envelope.actor.userId = actor.userId;
  }
  if (actor.username !== undefined) {
    envelope.actor.username = actor.username;
  }
  return envelope;
};

const initChatPayload = (envelope: EventEnvelope, kind: ChatLikeKind): ChatPayload => {
  switch (CHAT_PAYLOAD_WHICH[kind]) {
    case EventEnvelope_Payload_Which.THREAD_START:
      return envelope.payload._initThreadStart();
    case EventEnvelope_Payload_Which.THREAD_REPLY:
      return envelope.payload._initThreadReply();
    case EventEnvelope_Payload_Which.ASK:
      return envelope.payload._initAsk();
    default:
      return envelope.payload._initChannelReply();
  }
};

export const encodeAiJobEnvelope = (job: AiJob, options: EnvelopeOptions): Uint8Array => {
  if (!validateAiJob(job)) {
    throw new Error("Invalid AI job for event envelope");
  }

  const message = new capnp.Message();
  // message.received events carry the guild id and author on the job itself.
  const envelope = job.kind === "message.received"
    ? initEnvelope(
      message,
      job.kind,
      { ...options, guildId: job.guildId },
      { userId: job.authorId, username: job.authorUsername },
    )
    : initEnvelope(message, job.kind, options, {
      userId: job.requesterUserId,
      username: job.requesterUsername,
    });

  if (job.kind === "ragjam") {
    const payload = envelope.payload._initRagjam();
    payload.applicationId = job.applicationId;
    payload.interactionToken = job.interactionToken;
    if (job.channelId !== undefined) {
      payload.channelId = job.channelId;
    }
    payload.prompt = job.prompt;
    if (job.lyrics !== undefined) {
      payload.lyrics = job.lyrics;
    }
  } else if (job.kind === "bicture") {
    const payload = envelope.payload._initBicture();
    payload.applicationId = job.applicationId;
    payload.interactionToken = job.interactionToken;
    if (job.channelId !== undefined) {
      payload.channelId = job.channelId;
    }
    payload.prompt = job.prompt;
  } else if (job.kind === "message.received") {
    const payload = envelope.payload._initMessageReceived();
    payload.messageId = job.messageId;
    payload.channelId = job.channelId;
    payload.botUserId = job.botUserId;
    payload.content = job.content;
    const userIds = payload._initMentionUserIds(job.mentionUserIds.length);
    job.mentionUserIds.forEach((id, index) => userIds.set(index, id));
    const roleIds = payload._initMentionRoleIds(job.mentionRoleIds.length);
    job.mentionRoleIds.forEach((id, index) => roleIds.set(index, id));
    if (job.replyMessageId !== undefined) {
      payload.replyMessageId = job.replyMessageId;
    }
    if (job.replyChannelId !== undefined) {
      payload.replyChannelId = job.replyChannelId;
    }
  } else {
    const payload = initChatPayload(envelope, job.kind);
    payload.channelId = job.channelId;
    if (job.messageId !== undefined) {
      payload.messageId = job.messageId;
    }
    if (job.botUserId !== undefined) {
      payload.botUserId = job.botUserId;
    }
    payload.prompt = job.prompt;
    if (job.replyMessageId !== undefined) {
      payload.replyMessageId = job.replyMessageId;
    }
    if (job.replyChannelId !== undefined) {
      payload.replyChannelId = job.replyChannelId;
    }
  }

  return new Uint8Array(message.toArrayBuffer());
};

export const encodeReplyJobEnvelope = (job: ReplyJob, options: EnvelopeOptions): Uint8Array => {
  if (!validateReplyJob(job)) {
    throw new Error("Invalid reply job for event envelope");
  }

  const message = new capnp.Message();
  const envelope = initEnvelope(message, job.kind, options);
  if (job.kind === "reply.channel_message") {
    const payload = envelope.payload._initReplyChannelMessage();
    payload.channelId = job.channelId;
    payload.content = job.content;
  } else {
    const payload = envelope.payload._initReplyInteractionEdit();
    payload.applicationId = job.applicationId;
    payload.interactionToken = job.interactionToken;
    payload.content = job.content;
  }
  return new Uint8Array(message.toArrayBuffer());
};

export const encodeAiSpendJobEnvelope = (job: AiSpendJob, options: EnvelopeOptions): Uint8Array => {
  if (!validateAiSpendJob(job)) {
    throw new Error("Invalid AI spend job for event envelope");
  }

  const message = new capnp.Message();
  const envelope = initEnvelope(message, SPEND_EVENT_TYPE, options);
  envelope.payload._initSpend().spendEventId = job.spendEventId;
  return new Uint8Array(message.toArrayBuffer());
};

const readEnvelope = (value: unknown): EventEnvelope | null => {
  const bytes = asFramedBytes(value);
  if (!bytes) {
    return null;
  }
  try {
    const envelope = new capnp.Message(bytes, false).getRoot(EventEnvelope);
    if (envelope.v !== ENVELOPE_VERSION || !isOptionalSnowflake(optionalText(envelope.guildId))) {
      return null;
    }
    return envelope;
  } catch {
    return null;
  }
};

const chatJobFrom = (envelope: EventEnvelope, kind: ChatLikeKind, payload: ChatPayload) =>
  compact({
    kind,
    channelId: payload.channelId,
    messageId: optionalText(payload.messageId),
    botUserId: optionalText(payload.botUserId),
    requesterUserId: optionalText(envelope.actor.userId),
    requesterUsername: optionalText(envelope.actor.username),
    prompt: payload.prompt,
    replyMessageId: optionalText(payload.replyMessageId),
    replyChannelId: optionalText(payload.replyChannelId),
  });

const aiJobFrom = (envelope: EventEnvelope): unknown => {
  switch (envelope.payload.which()) {
    case EventEnvelope_Payload_Which.THREAD_START:
      return chatJobFrom(envelope, "thread_start", envelope.payload.threadStart);
    case EventEnvelope_Payload_Which.THREAD_REPLY:
      return chatJobFrom(envelope, "thread_reply", envelope.payload.threadReply);
    case EventEnvelope_Payload_Which.CHANNEL_REPLY:
      return chatJobFrom(envelope, "channel_reply", envelope.payload.channelReply);
    case EventEnvelope_Payload_Which.ASK:
      return chatJobFrom(envelope, "ask", envelope.payload.ask);
    case EventEnvelope_Payload_Which.RAGJAM: {
      const payload = envelope.payload.ragjam;
      const job: RagjamJob = compact({
        kind: "ragjam",
        applicationId: payload.applicationId,
        interactionToken: payload.interactionToken,
        channelId: optionalText(payload.channelId),
        requesterUserId: optionalText(envelope.actor.userId),
        requesterUsername: optionalText(envelope.actor.username),
        prompt: payload.prompt,
        lyrics: optionalText(payload.lyrics),
      });
      return job;
    }
    case EventEnvelope_Payload_Which.BICTURE: {
      const payload = envelope.payload.bicture;
      const job: BictureJob = compact({
        kind: "bicture",
        applicationId: payload.applicationId,
        interactionToken: payload.interactionToken,
        channelId: optionalText(payload.channelId),
        requesterUserId: optionalText(envelope.actor.userId),
        requesterUsername: optionalText(envelope.actor.username),
        prompt: payload.prompt,
      });
      return job;
    }
    case EventEnvelope_Payload_Which.MESSAGE_RECEIVED: {
      const payload = envelope.payload.messageReceived;
      const job: MessageReceivedJob = compact({
        kind: "message.received",
        messageId: payload.messageId,
        channelId: payload.channelId,
        guildId: optionalText(envelope.guildId),
        botUserId: payload.botUserId,
        authorId: optionalText(envelope.actor.userId),
        authorUsername: optionalText(envelope.actor.username),
        content: payload.content,
        mentionUserIds: textListToArray(payload.mentionUserIds),
        mentionRoleIds: textListToArray(payload.mentionRoleIds),
        replyMessageId: optionalText(payload.replyMessageId),
        replyChannelId: optionalText(payload.replyChannelId),
      });
      return job;
    }
    default:
      return null;
  }
};

// Read an envelope's operation — its `type` discriminator — from the framed
// bytes without decoding or trusting the payload union. The receiving service
// boundary checks this against its registered operation set before Cedar and
// before any payload decode, so an unregistered operation never reaches the
// authorizer or domain code. Returns null when the bytes are not a sanely
// framed envelope of the current version, or carry no type.
export const peekEnvelopeOperation = (bytes: unknown): string | null => {
  const envelope = readEnvelope(bytes);
  if (!envelope) {
    return null;
  }
  return envelope.type.length > 0 ? envelope.type : null;
};

export const decodeAiJobEnvelope = (bytes: unknown): AiJob | null => {
  const envelope = readEnvelope(bytes);
  if (!envelope) {
    return null;
  }
  try {
    const job = aiJobFrom(envelope);
    return validateAiJob(job) && envelope.type === job.kind ? job : null;
  } catch {
    return null;
  }
};

const replyJobFrom = (envelope: EventEnvelope): ReplyJob | null => {
  switch (envelope.payload.which()) {
    case EventEnvelope_Payload_Which.REPLY_CHANNEL_MESSAGE: {
      const payload = envelope.payload.replyChannelMessage;
      return {
        kind: "reply.channel_message",
        channelId: payload.channelId,
        content: payload.content,
      };
    }
    case EventEnvelope_Payload_Which.REPLY_INTERACTION_EDIT: {
      const payload = envelope.payload.replyInteractionEdit;
      return {
        kind: "reply.interaction_edit",
        applicationId: payload.applicationId,
        interactionToken: payload.interactionToken,
        content: payload.content,
      };
    }
    default:
      return null;
  }
};

export const decodeReplyJobEnvelope = (bytes: unknown): ReplyJob | null => {
  const envelope = readEnvelope(bytes);
  if (!envelope) {
    return null;
  }
  try {
    const job = replyJobFrom(envelope);
    return job && validateReplyJob(job) && envelope.type === job.kind ? job : null;
  } catch {
    return null;
  }
};

export const encodeDevProxyCommandEnvelope = (
  job: DevProxyCommandJob,
  options: EnvelopeOptions,
): Uint8Array => {
  if (!validateDevProxyCommandJob(job)) {
    throw new Error("Invalid dev-proxy command for event envelope");
  }
  const message = new capnp.Message();
  const envelope = initEnvelope(message, DEVPROXY_COMMAND_TYPE, options);
  const payload = envelope.payload._initDevproxyCommand();
  payload.command = job.command;
  payload.subjectUserId = job.subjectUserId;
  if (job.subjectUsername !== undefined) {
    payload.subjectUsername = job.subjectUsername;
  }
  if (job.guildId !== undefined) {
    payload.guildId = job.guildId;
  }
  if (job.channelId !== undefined) {
    payload.channelId = job.channelId;
  }
  if (job.applicationId !== undefined) {
    payload.applicationId = job.applicationId;
  }
  if (job.interactionToken !== undefined) {
    payload.interactionToken = job.interactionToken;
  }
  const optionList = payload._initOptions(job.options.length);
  job.options.forEach((option, index) => {
    const entry = optionList.get(index);
    entry.name = option.name;
    entry.value = option.value;
  });
  return new Uint8Array(message.toArrayBuffer());
};

const devProxyOptionsToArray = (payload: DevProxyCommandPayload): DevProxyCommandOption[] =>
  Array.from({ length: payload.options.length }, (_, index) => {
    const entry = payload.options.get(index);
    return { name: entry.name, value: entry.value };
  });

export const decodeDevProxyCommandEnvelope = (bytes: unknown): DevProxyCommandJob | null => {
  const envelope = readEnvelope(bytes);
  if (!envelope) {
    return null;
  }
  try {
    if (envelope.payload.which() !== EventEnvelope_Payload_Which.DEVPROXY_COMMAND) {
      return null;
    }
    const payload = envelope.payload.devproxyCommand;
    const job: DevProxyCommandJob = compact({
      kind: "devproxy.command",
      command: payload.command,
      subjectUserId: payload.subjectUserId,
      subjectUsername: optionalText(payload.subjectUsername),
      guildId: optionalText(payload.guildId),
      channelId: optionalText(payload.channelId),
      applicationId: optionalText(payload.applicationId),
      interactionToken: optionalText(payload.interactionToken),
      options: devProxyOptionsToArray(payload),
    });
    return validateDevProxyCommandJob(job) && envelope.type === DEVPROXY_COMMAND_TYPE ? job : null;
  } catch {
    return null;
  }
};

export const encodeConnectorInvokeEnvelope = (
  job: ConnectorInvokeJob,
  options: EnvelopeOptions,
): Uint8Array => {
  if (!validateConnectorInvokeJob(job)) {
    throw new Error("Invalid connector invocation for event envelope");
  }
  const message = new capnp.Message();
  const envelope = initEnvelope(message, CONNECTOR_INVOKE_TYPE, options);
  const payload = envelope.payload._initConnectorInvoke();
  payload.operation = job.operation;
  if (job.connectorId !== undefined) {
    payload.connectorId = job.connectorId;
  }
  if (job.handle !== undefined) {
    payload.handle = job.handle;
  }
  if (job.subject !== undefined) {
    payload.subject = job.subject;
  }
  const scopeList = payload._initScopes(job.scopes.length);
  job.scopes.forEach((scope, index) => scopeList.set(index, scope));
  payload.paramsJson = job.paramsJson;
  return new Uint8Array(message.toArrayBuffer());
};

const connectorInvokeFrom = (payload: ConnectorInvokePayload): ConnectorInvokeJob =>
  compact({
    kind: "connector.invoke",
    operation: payload.operation,
    connectorId: optionalText(payload.connectorId),
    handle: optionalText(payload.handle),
    subject: optionalText(payload.subject),
    scopes: textListToArray(payload.scopes),
    paramsJson: payload.paramsJson,
  }) as ConnectorInvokeJob;

export const decodeConnectorInvokeEnvelope = (bytes: unknown): ConnectorInvokeJob | null => {
  const envelope = readEnvelope(bytes);
  if (!envelope) {
    return null;
  }
  try {
    if (envelope.payload.which() !== EventEnvelope_Payload_Which.CONNECTOR_INVOKE) {
      return null;
    }
    const job = connectorInvokeFrom(envelope.payload.connectorInvoke);
    return validateConnectorInvokeJob(job) && envelope.type === CONNECTOR_INVOKE_TYPE ? job : null;
  } catch {
    return null;
  }
};

export const encodeWebhookEventEnvelope = (
  job: WebhookEventJob,
  options: EnvelopeOptions,
): Uint8Array => {
  if (!validateWebhookEventJob(job)) {
    throw new Error("Invalid webhook event for event envelope");
  }
  const message = new capnp.Message();
  const envelope = initEnvelope(message, WEBHOOK_EVENT_TYPE, options);
  const payload = envelope.payload._initWebhookEvent();
  payload.connectorId = job.connectorId;
  payload.provider = job.provider;
  if (job.eventId !== undefined) {
    payload.eventId = job.eventId;
  }
  if (job.eventType !== undefined) {
    payload.eventType = job.eventType;
  }
  payload.receivedAt = job.receivedAt;
  payload.bodyBase64 = job.bodyBase64;
  return new Uint8Array(message.toArrayBuffer());
};

export const encodeEgressRequestEnvelope = (
  job: EgressRequestJob,
  options: EnvelopeOptions,
): Uint8Array => {
  if (!validateEgressRequestJob(job)) {
    throw new Error("Invalid egress request for event envelope");
  }
  const message = new capnp.Message();
  const envelope = initEnvelope(message, EGRESS_REQUEST_TYPE, options);
  const payload = envelope.payload._initEgressRequest();
  payload.profile = job.profile;
  payload.method = job.method;
  payload.url = job.url;
  payload.headersJson = job.headersJson;
  if (job.bodySha256 !== undefined) {
    payload.bodySha256 = job.bodySha256;
  }
  return new Uint8Array(message.toArrayBuffer());
};

export const encodeApplicationRequestEnvelope = (
  job: ApplicationRequestJob,
  options: EnvelopeOptions,
): Uint8Array => {
  if (!validateApplicationRequestJob(job)) {
    throw new Error("Invalid application request for event envelope");
  }
  const message = new capnp.Message();
  const envelope = initEnvelope(message, APPLICATION_REQUEST_TYPE, options);
  const payload = envelope.payload._initApplicationRequest();
  payload.applicationId = job.applicationId;
  payload.operationId = job.operationId;
  payload.serviceOperation = job.serviceOperation;
  payload.method = job.method;
  payload.url = job.url;
  payload.headersJson = job.headersJson;
  payload.bodyBase64 = job.bodyBase64;
  payload.linkedTokenSha256 = job.linkedTokenSha256;
  return new Uint8Array(message.toArrayBuffer());
};

export const encodeRegistryInvokeEnvelope = (
  job: RegistryInvokeJob,
  options: EnvelopeOptions,
): Uint8Array => {
  if (!validateRegistryInvokeJob(job)) {
    throw new Error("Invalid registry invocation for event envelope");
  }
  const message = new capnp.Message();
  const envelope = initEnvelope(message, REGISTRY_INVOKE_TYPE, options);
  const payload = envelope.payload._initRegistryInvoke();
  payload.operation = job.operation;
  payload.actorJson = job.actorJson;
  payload.bodyJson = job.bodyJson;
  if (job.targetId !== undefined) {
    payload.targetId = job.targetId;
  }
  return new Uint8Array(message.toArrayBuffer());
};

export const encodeMetadataQueryEnvelope = (
  job: MetadataQueryJob,
  options: EnvelopeOptions,
): Uint8Array => {
  if (!validateMetadataQueryJob(job)) {
    throw new Error("Invalid metadata query for event envelope");
  }
  const message = new capnp.Message();
  const envelope = initEnvelope(message, METADATA_QUERY_TYPE, options);
  const payload = envelope.payload._initMetadataQuery();
  payload.query = job.query;
  payload.variablesJson = job.variablesJson;
  if (job.operationName !== undefined) {
    payload.operationName = job.operationName;
  }
  return new Uint8Array(message.toArrayBuffer());
};

export const encodeAttestInvokeEnvelope = (
  job: AttestInvokeJob,
  options: EnvelopeOptions,
): Uint8Array => {
  if (!validateAttestInvokeJob(job)) {
    throw new Error("Invalid attest invocation for event envelope");
  }
  const message = new capnp.Message();
  const envelope = initEnvelope(message, ATTEST_INVOKE_TYPE, options);
  const payload = envelope.payload._initAttestInvoke();
  payload.operation = job.operation;
  payload.headersJson = job.headersJson;
  payload.bodyBase64 = job.bodyBase64;
  return new Uint8Array(message.toArrayBuffer());
};

const webhookEventFrom = (payload: WebhookEventPayload): WebhookEventJob =>
  compact({
    kind: "webhook.event",
    connectorId: payload.connectorId,
    provider: payload.provider as WebhookEventProvider,
    eventId: optionalText(payload.eventId),
    eventType: optionalText(payload.eventType),
    receivedAt: payload.receivedAt,
    bodyBase64: payload.bodyBase64,
  }) as WebhookEventJob;

export const decodeWebhookEventEnvelope = (bytes: unknown): WebhookEventJob | null => {
  const envelope = readEnvelope(bytes);
  if (!envelope) {
    return null;
  }
  try {
    if (envelope.payload.which() !== EventEnvelope_Payload_Which.WEBHOOK_EVENT) {
      return null;
    }
    const job = webhookEventFrom(envelope.payload.webhookEvent);
    return validateWebhookEventJob(job) && envelope.type === WEBHOOK_EVENT_TYPE ? job : null;
  } catch {
    return null;
  }
};

const egressRequestFrom = (payload: EgressRequestPayload): EgressRequestJob =>
  compact({
    kind: "egress.request",
    profile: payload.profile,
    method: payload.method,
    url: payload.url,
    headersJson: payload.headersJson,
    bodySha256: optionalText(payload.bodySha256),
  }) as EgressRequestJob;

const applicationRequestFrom = (payload: ApplicationRequestPayload): ApplicationRequestJob =>
  compact({
    kind: "application.request",
    applicationId: payload.applicationId,
    operationId: payload.operationId,
    serviceOperation: payload.serviceOperation,
    method: payload.method,
    url: payload.url,
    headersJson: payload.headersJson,
    bodyBase64: payload.bodyBase64,
    linkedTokenSha256: payload.linkedTokenSha256,
  }) as ApplicationRequestJob;

const registryInvokeFrom = (payload: RegistryInvokePayload): RegistryInvokeJob =>
  compact({
    kind: "registry.invoke",
    operation: payload.operation,
    actorJson: payload.actorJson,
    bodyJson: payload.bodyJson,
    targetId: optionalText(payload.targetId),
  }) as RegistryInvokeJob;

const metadataQueryFrom = (payload: MetadataQueryPayload): MetadataQueryJob =>
  compact({
    kind: "metadata.query",
    query: payload.query,
    variablesJson: payload.variablesJson,
    operationName: optionalText(payload.operationName),
  }) as MetadataQueryJob;

const attestInvokeFrom = (payload: AttestInvokePayload): AttestInvokeJob =>
  compact({
    kind: "attest.invoke",
    operation: payload.operation,
    headersJson: payload.headersJson,
    bodyBase64: payload.bodyBase64,
  }) as AttestInvokeJob;

export const decodeEgressRequestEnvelope = (bytes: unknown): EgressRequestJob | null => {
  const envelope = readEnvelope(bytes);
  if (!envelope) {
    return null;
  }
  try {
    if (envelope.payload.which() !== EventEnvelope_Payload_Which.EGRESS_REQUEST) {
      return null;
    }
    const job = egressRequestFrom(envelope.payload.egressRequest);
    return validateEgressRequestJob(job) && envelope.type === EGRESS_REQUEST_TYPE ? job : null;
  } catch {
    return null;
  }
};

export const decodeApplicationRequestEnvelope = (bytes: unknown): ApplicationRequestJob | null => {
  const envelope = readEnvelope(bytes);
  if (!envelope) {
    return null;
  }
  try {
    if (envelope.payload.which() !== EventEnvelope_Payload_Which.APPLICATION_REQUEST) {
      return null;
    }
    const job = applicationRequestFrom(envelope.payload.applicationRequest);
    return validateApplicationRequestJob(job) && envelope.type === APPLICATION_REQUEST_TYPE ? job : null;
  } catch {
    return null;
  }
};

export const decodeRegistryInvokeEnvelope = (bytes: unknown): RegistryInvokeJob | null => {
  const envelope = readEnvelope(bytes);
  if (!envelope) {
    return null;
  }
  try {
    if (envelope.payload.which() !== EventEnvelope_Payload_Which.REGISTRY_INVOKE) {
      return null;
    }
    const job = registryInvokeFrom(envelope.payload.registryInvoke);
    return validateRegistryInvokeJob(job) && envelope.type === REGISTRY_INVOKE_TYPE ? job : null;
  } catch {
    return null;
  }
};

export const decodeMetadataQueryEnvelope = (bytes: unknown): MetadataQueryJob | null => {
  const envelope = readEnvelope(bytes);
  if (!envelope) {
    return null;
  }
  try {
    if (envelope.payload.which() !== EventEnvelope_Payload_Which.METADATA_QUERY) {
      return null;
    }
    const job = metadataQueryFrom(envelope.payload.metadataQuery);
    return validateMetadataQueryJob(job) && envelope.type === METADATA_QUERY_TYPE ? job : null;
  } catch {
    return null;
  }
};

export const decodeAttestInvokeEnvelope = (bytes: unknown): AttestInvokeJob | null => {
  const envelope = readEnvelope(bytes);
  if (!envelope) {
    return null;
  }
  try {
    if (envelope.payload.which() !== EventEnvelope_Payload_Which.ATTEST_INVOKE) {
      return null;
    }
    const job = attestInvokeFrom(envelope.payload.attestInvoke);
    return validateAttestInvokeJob(job) && envelope.type === ATTEST_INVOKE_TYPE ? job : null;
  } catch {
    return null;
  }
};

export const decodeAiSpendJobEnvelope = (bytes: unknown): AiSpendJob | null => {
  const envelope = readEnvelope(bytes);
  if (!envelope) {
    return null;
  }
  try {
    if (envelope.payload.which() !== EventEnvelope_Payload_Which.SPEND) {
      return null;
    }
    const job: AiSpendJob = { spendEventId: envelope.payload.spend.spendEventId };
    return validateAiSpendJob(job) && envelope.type === SPEND_EVENT_TYPE ? job : null;
  } catch {
    return null;
  }
};
