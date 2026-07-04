// Platform-app message contracts: registry invocations, metadata queries,
// attest webhook relays, and the platform bindings env slice.
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
  type ServiceMessageBytes,
} from "@rag/contracts-core";
import {
  EventEnvelope_Payload_Which,
  type AttestInvokePayload,
  type MetadataQueryPayload,
  type RegistryInvokePayload,
} from "@rag/contracts-core/envelope";
import { APPLICATION_ID_PATTERN, type EgressEnv } from "@rag/egress/contracts";
import { MAX_WEBHOOK_BODY_BASE64_LENGTH, type ConnectorsEnv } from "@rag/connectors/contracts";
import type { IngressEnv } from "@rag/ingress/env";
import type { SecretsEnv } from "@rag/secrets/env";
import type { ServiceKitEnv } from "@rag/service-kit/env";

export type RegistryInvokeOperation =
  | "application.list"
  | "application.create"
  | "application.get"
  | "application.update"
  | "application.delete"
  | "application.attestations.verify";

export type RegistryInvokeJob = {
  kind: "registry.invoke";
  operation: RegistryInvokeOperation;
  actorJson: string;
  bodyJson: string;
  targetId?: string;
};

export type MetadataQueryJob = {
  kind: "metadata.query";
  query: string;
  variablesJson: string;
  operationName?: string;
};

// The single operation attest's own service-binding entrypoint accepts today:
// an HTTP-shaped GitHub webhook delivery relayed by the middleware client
// after its own edge-level method/size checks. Mirrors RegistryInvokeOperation.
export type AttestInvokeOperation = "webhook.github";

// headersJson carries ONLY the small filtered GitHub signature headers
// (x-hub-signature-256, x-github-delivery, x-github-event) as a JSON object —
// never the full request header set. bodyBase64 is the raw webhook body,
// capped at MAX_WEBHOOK_BODY_BYTES before base64 (like WebhookEventJob).
export type AttestInvokeJob = {
  kind: "attest.invoke";
  operation: AttestInvokeOperation;
  headersJson: string;
  bodyBase64: string;
};

export type RegistryInvokeResult = {
  status: number;
  body: unknown;
};

export type MetadataQueryResult = {
  status: number;
  body: unknown;
};

export type AttestInvokeResult = {
  status: number;
  body: unknown;
};

// The platform apps' bindings (registry, metadata, attest).
export type PlatformEnv = {
  METADATA_QUERY_TOKEN?: string;
  REGISTRY_APPLICATIONS?: {
    idFromName: (name: string) => DurableObjectId;
    get: (id: DurableObjectId) => {
      create: (input: unknown) => Promise<unknown>;
      get: (id: string) => Promise<unknown | null>;
      list: () => Promise<unknown[]>;
      update: (id: string, input: unknown) => Promise<unknown | null>;
      remove: (id: string, actor: unknown) => Promise<unknown | null>;
      putScaffoldResult: (applicationId: string, result: unknown) => Promise<void>;
      getScaffoldResult: (applicationId: string) => Promise<unknown | null>;
    };
  };
  // The per-application authority DO (idFromName(appId)): owns each
  // application's member set + signing key and mints act-as tokens. Defined by
  // the registry worker; bound cross-script by callers that need to mint.
  APPLICATION_AUTHORITY?: {
    idFromName: (name: string) => DurableObjectId;
    get: (id: DurableObjectId) => {
      configure: (input: unknown) => Promise<unknown | null>;
      get: () => Promise<unknown | null>;
      addMember: (appId: unknown, member: unknown) => Promise<unknown | null>;
      removeMember: (appId: unknown, member: unknown) => Promise<unknown | null>;
      jwks: () => Promise<{ keys: JsonWebKey[] }>;
      mint: (input: unknown) => Promise<
        | { ok: true; token: string; expiresIn: number }
        | { ok: false; reason: string }
      >;
    };
  };
  // OPTIONAL static override, JSON map { appId: publicJwk }, for resolving an
  // act-as token issuer's key without a runtime JWKS fetch (tests, pinning).
  // Public keys are not secret. Normally unset: the ApplicationAuthority DO
  // generates its own key and actAsResolverFromAuthority fetches the public half
  // from its jwks() at runtime, so no signing material is ever provisioned.
  APPLICATION_PUBLIC_KEYS?: string;
  REGISTRY_SERVICE?: {
    invoke: (message: ServiceMessageBytes) => Promise<RegistryInvokeResult>;
  };
  METADATA_SERVICE?: {
    invoke: (message: ServiceMessageBytes) => Promise<MetadataQueryResult>;
  };
  ATTEST_SERVICE?: {
    invoke: (message: ServiceMessageBytes) => Promise<AttestInvokeResult>;
  };
  ATTESTATIONS?: {
    idFromName: (name: string) => DurableObjectId;
    get: (id: DurableObjectId) => {
      record: (attestation: unknown) => Promise<void>;
      list: (repository?: string) => Promise<unknown[]>;
      verifyArtifact: (input: unknown) => Promise<unknown>;
      seenDelivery: (deliveryId: string, ttlMs: number) => Promise<boolean>;
    };
  };
  REGISTRY_GITHUB_INSTALLATION_ID?: string;
  REGISTRY_GITHUB_OWNER?: string;
  REGISTRY_GITHUB_REPO?: string;
  REGISTRY_GITHUB_BASE_BRANCH?: string;
  ATTEST_GITHUB_OWNER?: string;
  ATTEST_GITHUB_REPO?: string;
};

export type Env = Cloudflare.Env & ServiceKitEnv & IngressEnv & EgressEnv & SecretsEnv & ConnectorsEnv & PlatformEnv;

export const MAX_REGISTRY_ACTOR_JSON_LENGTH = 2048;
export const MAX_REGISTRY_BODY_JSON_LENGTH = 96 * 1024;
export const MAX_METADATA_QUERY_LENGTH = 16 * 1024;
export const MAX_METADATA_VARIABLES_JSON_LENGTH = 32 * 1024;
export const MAX_METADATA_OPERATION_NAME_LENGTH = 128;

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

const REGISTRY_INVOKE_TYPE = "registry.invoke";
const METADATA_QUERY_TYPE = "metadata.query";
const ATTEST_INVOKE_TYPE = "attest.invoke";

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
