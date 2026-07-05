// The envelope kernel: framed capnp EventEnvelope plumbing and the validation
// primitives. App message types and their encoders/decoders live with the
// owning app (apps/*/contracts) or package (@rag/egress/contracts) — this
// package must stay a leaf. Queue payloads are plain EventEnvelope bytes.
import * as capnp from "capnp-es";
import { EventEnvelope } from "./envelope";
import { asFramedBytes } from "./framing";
import { isOptionalSnowflake } from "./validate";

export * from "./validate";
export { isRecord } from "./validation";
export { asFramedBytes, isSaneFramedMessage, MAX_MESSAGE_BYTES } from "./framing";

export const ENVELOPE_VERSION = 1;

export type EventSource = "interactions" | "gateway" | "worker";

export type EnvelopeOptions = {
  source: EventSource;
  guildId?: string;
};

export const optionalText = (value: string) => (value.length > 0 ? value : undefined);

export const textListToArray = (list: capnp.List<string>): string[] =>
  Array.from({ length: list.length }, (_, index) => list.get(index));

export const compact = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;

export const initEnvelope = (
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

export const readEnvelope = (value: unknown): EventEnvelope | null => {
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
