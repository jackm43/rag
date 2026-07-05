import * as capnp from "capnp-es";
import {
  BASE64_PATTERN,
  compact,
  initEnvelope,
  isRecord,
  isString,
  optionalText,
  readEnvelope,
  type EnvelopeOptions,
} from "@rag/contracts-core";
import { EventEnvelope_Payload_Which, type WebhookEventPayload } from "@rag/contracts-core/envelope";

// The verified-webhook contract, moved here from the (now-removed) connectors
// package. A webhook.event is enqueued by the webhooks edge worker after the
// auth service confirmed the provider signature, and consumed off the
// webhook-jobs queue by the workflows worker.

export type WebhookEventProvider = "github";

export type WebhookEventJob = {
  kind: "webhook.event";
  connectorId: string;
  provider: WebhookEventProvider;
  eventId?: string;
  eventType?: string;
  receivedAt: string;
  bodyBase64: string;
};

export const CONNECTOR_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const WEBHOOK_PROVIDERS: readonly WebhookEventProvider[] = ["github"];
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
export const MAX_WEBHOOK_BODY_BASE64_LENGTH = Math.ceil(MAX_WEBHOOK_BODY_BYTES / 3) * 4;
export const MAX_WEBHOOK_EVENT_ID_LENGTH = 200;
export const MAX_WEBHOOK_EVENT_TYPE_LENGTH = 100;

const WEBHOOK_EVENT_TYPE = "webhook.event";

export const validateWebhookEventJob = (value: unknown): value is WebhookEventJob =>
  isRecord(value) &&
  value.kind === "webhook.event" &&
  isString(value.connectorId) &&
  CONNECTOR_ID_PATTERN.test(value.connectorId) &&
  WEBHOOK_PROVIDERS.includes(value.provider as WebhookEventProvider) &&
  (value.eventId === undefined ||
    (isString(value.eventId) && value.eventId.length > 0 && value.eventId.length <= MAX_WEBHOOK_EVENT_ID_LENGTH)) &&
  (value.eventType === undefined ||
    (isString(value.eventType) && value.eventType.length > 0 && value.eventType.length <= MAX_WEBHOOK_EVENT_TYPE_LENGTH)) &&
  isString(value.receivedAt) &&
  value.receivedAt.length <= 40 &&
  !Number.isNaN(Date.parse(value.receivedAt)) &&
  isString(value.bodyBase64) &&
  value.bodyBase64.length <= MAX_WEBHOOK_BODY_BASE64_LENGTH &&
  value.bodyBase64.length % 4 === 0 &&
  BASE64_PATTERN.test(value.bodyBase64);

export const encodeWebhookEventEnvelope = (job: WebhookEventJob, options: EnvelopeOptions): Uint8Array => {
  if (!validateWebhookEventJob(job)) {
    throw new Error("Invalid webhook event for event envelope");
  }
  const message = new capnp.Message();
  const envelope = initEnvelope(message, WEBHOOK_EVENT_TYPE, options);
  const payload = envelope.payload._initWebhookEvent();
  payload.connectorId = job.connectorId;
  payload.provider = job.provider;
  if (job.eventId !== undefined) payload.eventId = job.eventId;
  if (job.eventType !== undefined) payload.eventType = job.eventType;
  payload.receivedAt = job.receivedAt;
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
  if (!envelope) return null;
  try {
    if (envelope.payload.which() !== EventEnvelope_Payload_Which.WEBHOOK_EVENT) return null;
    const job = webhookEventFrom(envelope.payload.webhookEvent);
    return validateWebhookEventJob(job) && envelope.type === WEBHOOK_EVENT_TYPE ? job : null;
  } catch {
    return null;
  }
};
