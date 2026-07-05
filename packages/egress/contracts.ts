// Egress-boundary message contracts: the egress.request sidecar hop and the
// application.request generic HTTP hop, plus their env slice. Owned by
// @rag/egress because both jobs exist only to cross its boundary.
import * as capnp from "capnp-es";
import {
  BASE64_PATTERN,
  BASE64URL_SHA256_PATTERN,
  compact,
  initEnvelope,
  isRecord,
  isString,
  optionalText,
  readEnvelope,
  type EnvelopeOptions,
  type ServiceMessageBytes,
} from "@rag/contracts-core";
import {
  EventEnvelope_Payload_Which,
  type ApplicationRequestPayload,
  type EgressRequestPayload,
} from "@rag/contracts-core/envelope";

export type EgressRequestJob = {
  kind: "egress.request";
  profile: string;
  method: string;
  url: string;
  headersJson: string;
  bodySha256?: string;
};

export type EgressResult = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: ArrayBuffer;
};

// The plain RPC input the egress sidecar receives over its capability-gated
// service binding. No capnp envelope, no signed identity token: only a worker
// whose wrangler declares the EGRESS binding can call, so the binding graph
// authenticates the caller. `caller` selects the (caller, profile) config and
// its credential; the profile's allowedCallers gates it.
export type EgressFetchInput = {
  caller: string;
  profile: string;
  method: string;
  url: string;
  headers: Record<string, string>;
};

export type EgressCredentialRef = {
  header: string;
  env: string;
  prefix?: string;
};

export type EgressProfileConfig = {
  identity?: string;
  allowedCallers: string[];
  allowedHosts: string[];
  timeoutMs?: number;
  maxResponseBytes?: number;
  logPath?: boolean;
  credential?: EgressCredentialRef;
};

export type ApplicationRequestJob = {
  kind: "application.request";
  applicationId: string;
  operationId: string;
  serviceOperation: string;
  method: string;
  url: string;
  headersJson: string;
  bodyBase64: string;
  linkedTokenSha256: string;
};

export type PreparedApplicationRequest =
  | { ok: true; message: ServiceMessageBytes }
  | { ok: false; status: number; error: string };

// The env slice the egress boundary reads (both sidecar halves plus the
// application-request linked-token check).
export type EgressEnv = {
  LINKED_APP_TOKEN?: string;
  LINKED_APP_TOKEN_SHA256?: string;
  // Generic bound egress proxy. Application workers call this over the EGRESS
  // service binding with a plain EgressFetchInput plus optional raw body bytes.
  // The egress worker owns host allowlists and credential injection for the
  // named profile.
  EGRESS?: {
    fetchProfile: (input: EgressFetchInput, body?: ArrayBuffer) => Promise<EgressResult>;
  };
  // Per-application egress profile authority. The egress worker selects an
  // object by verified caller/application, then resolves the requested profile.
  EGRESS_CONTROL?: {
    idFromName: (name: string) => DurableObjectId;
    get: (id: DurableObjectId) => {
      getProfile: (profile: string) => Promise<EgressProfileConfig | null>;
      putProfile: (profile: string, config: EgressProfileConfig) => Promise<void>;
      snapshot: () => Promise<Record<string, EgressProfileConfig>>;
    };
  };
};

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
const EGRESS_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;
const APPLICATION_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

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

const EGRESS_REQUEST_TYPE = "egress.request";
const APPLICATION_REQUEST_TYPE = "application.request";

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
