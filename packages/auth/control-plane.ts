import { peekEnvelopeOperation } from "../contracts";
import type { Env } from "../contracts/types";
import { logger } from "../logger";
import type { CorrelatedJwtClaims } from "./claims";
import { SERVICE_ZONE, type MachinePrincipal, type Subject } from "./principal";
import { serviceResourceId } from "./manifest";

const REGISTRY_NAME = "service-registry";
const REQUEST_TTL_MS = 5 * 60_000;
const PLACEMENT_TTL_MS = 90_000;
const ALL_APPLICATIONS = Object.keys(SERVICE_ZONE) as MachinePrincipal[];

export type RequestIntentRecord = CorrelatedJwtClaims<MachinePrincipal, MachinePrincipal> & {
  id: string;
  correlationId: string;
  subject: string;
  initiatingApplication: MachinePrincipal;
  action: string;
  resource: string;
  method: string;
  allowedApplications: MachinePrincipal[];
  expiresAt: number;
  version: number;
  revokedAt?: number;
};

export type PlacementRecord = CorrelatedJwtClaims<MachinePrincipal, MachinePrincipal> & {
  id: string;
  correlationId: string;
  requestId: string;
  subject: string;
  source: MachinePrincipal;
  target: MachinePrincipal;
  action: string;
  resource: string;
  method: string;
  expiresAt: number;
  intentVersion: number;
};

export type ConsumePlacementInput = {
  placementId: string;
  requestId: string;
  correlationId?: string;
  subject: string;
  source: MachinePrincipal;
  target: MachinePrincipal;
  action: string;
  resource: string;
  method: string;
};

export type HopIntent = {
  action: string;
  resource: string;
  method: string;
};

export type HopIntentInput = {
  action: string;
  resourceType?: string;
  resourceId: string;
  method: string;
};

export const createHopIntent = (input: HopIntentInput): HopIntent => ({
  action: input.action,
  resource: input.resourceType ? `${input.resourceType}:${input.resourceId}` : input.resourceId,
  method: input.method,
});

export type RequestControlPlane = {
  createIntent: (record: Omit<RequestIntentRecord, "id" | "iat" | "nbf" | "exp" | "expiresAt" | "version"> & {
    ttlMs?: number;
  }) => Promise<RequestIntentRecord>;
  createPlacement: (record: Omit<PlacementRecord, "id" | "iat" | "nbf" | "exp" | "expiresAt" | "intentVersion"> & {
    ttlMs?: number;
  }) => Promise<PlacementRecord | null>;
  consumePlacement: (input: ConsumePlacementInput) => Promise<boolean>;
  revokeIntent?: (requestId: string) => Promise<RequestIntentRecord | null>;
  bumpIntentVersion?: (requestId: string) => Promise<RequestIntentRecord | null>;
};

// The placement layer runs in exactly one of three modes, distinguished so a
// misconfigured worker cannot silently fall back to "no enforcement":
//
//   (a) permissive  — `env` itself is undefined. This is the test/no-control-
//       plane mode: callers that construct a server/client without an env
//       are opting out of the control plane entirely (unit tests exercising
//       Cedar or crypto in isolation), so placement is a no-op.
//   (b) misconfigured — `env` is provided but either `env.SERVICE_REGISTRY`
//       is missing, or the bound namespace's stub does not implement the
//       RequestControlPlane methods (the DO is bound but is the wrong
//       version/shape). Every deployed worker has this binding, so this only
//       happens on misconfiguration — exactly when the fail-closed doctrine
//       says to deny. `registryStub` returns a sentinel distinguishing this
//       from (a) so callers can fail closed instead of silently permitting.
//   (c) enforced — the binding is present and duck-types correctly. Normal
//       production behavior: every hop is authorized against the DO.
type RegistryStubResult =
  | { mode: "absent" }
  | { mode: "misconfigured" }
  | { mode: "ready"; control: RequestControlPlane };

const resolveRegistryStub = (env?: Env): RegistryStubResult => {
  if (env === undefined) {
    return { mode: "absent" };
  }
  const namespace = env.SERVICE_REGISTRY;
  if (!namespace) {
    return { mode: "misconfigured" };
  }
  const stub = namespace.get(namespace.idFromName(REGISTRY_NAME)) as unknown as Partial<RequestControlPlane>;
  if (
    typeof stub.createIntent === "function" &&
    typeof stub.createPlacement === "function" &&
    typeof stub.consumePlacement === "function"
  ) {
    return { mode: "ready", control: stub as RequestControlPlane };
  }
  // The namespace is bound but the stub it returns doesn't implement the
  // control-plane RPCs — the DO is there but the wrong version. Warn loudly
  // since this indicates a deploy/binding mismatch, not routine test setup.
  logger.warn("control_plane_stub_incompatible", { registry: REGISTRY_NAME });
  return { mode: "misconfigured" };
};

const registryStub = (env?: Env): RequestControlPlane | null => {
  const result = resolveRegistryStub(env);
  return result.mode === "ready" ? result.control : null;
};

export const CONTROL_PLANE_UNAVAILABLE_REASON = "control_plane_unavailable";

export const operationFromEnvelope = (envelope: Uint8Array): string => {
  const operation = peekEnvelopeOperation(envelope);
  if (operation === null) {
    throw new Error("Service envelope does not carry a registered operation");
  }
  return operation;
};

export const serviceHopIntent = (target: MachinePrincipal, envelope: Uint8Array): HopIntent => {
  const method = operationFromEnvelope(envelope);
  return {
    action: "service.invoke",
    resource: serviceResourceId(target, method),
    method,
  };
};

export const ensureRequestPlacement = async (params: {
  env?: Env;
  subject: Subject;
  source: MachinePrincipal;
  target: MachinePrincipal;
  intent: HopIntent;
}): Promise<{ requestId?: string; placementId?: string; correlationId?: string }> => {
  const resolved = resolveRegistryStub(params.env);
  if (resolved.mode === "absent") {
    return {};
  }
  if (resolved.mode === "misconfigured") {
    throw new Error(
      `Service call denied for ${params.source} -> ${params.target}: ${CONTROL_PLANE_UNAVAILABLE_REASON}`,
    );
  }
  const control = resolved.control;

  const correlationId = params.subject.correlationId ?? crypto.randomUUID();
  const requestId = params.subject.requestId ?? (await control.createIntent({
    iss: params.source,
    sub: params.subject.sub,
    aud: params.target,
    jti: crypto.randomUUID(),
    correlationId,
    subject: params.subject.sub,
    initiatingApplication: params.source,
    action: params.intent.action,
    resource: params.intent.resource,
    method: params.intent.method,
    // The path is dynamic: the intent constrains the subject/request lifetime,
    // and each concrete hop is still Cedar-authorized before placement. Keep
    // the next-application set broad so later services can derive their next
    // hop after doing domain work rather than over-planning the full path.
    allowedApplications: ALL_APPLICATIONS,
    ttlMs: REQUEST_TTL_MS,
  })).id;

  const placement = await control.createPlacement({
    iss: params.source,
    sub: params.subject.sub,
    aud: params.target,
    jti: crypto.randomUUID(),
    correlationId,
    requestId,
    subject: params.subject.sub,
    source: params.source,
    target: params.target,
    action: params.intent.action,
    resource: params.intent.resource,
    method: params.intent.method,
    ttlMs: PLACEMENT_TTL_MS,
  });
  if (!placement) {
    throw new Error(`Service call denied for ${params.source} -> ${params.target}: placement_not_authorized`);
  }
  return { requestId, placementId: placement.id, correlationId: placement.correlationId };
};

export const consumeRequestPlacement = async (params: {
  env?: Env;
  placementId?: string;
  requestId?: string;
  correlationId?: string;
  subject: string;
  source: MachinePrincipal;
  target: MachinePrincipal;
  intent: HopIntent;
}): Promise<boolean> => {
  const resolved = resolveRegistryStub(params.env);
  if (resolved.mode === "absent") {
    return true;
  }
  if (resolved.mode === "misconfigured") {
    return false;
  }
  const control = resolved.control;
  if (!params.placementId || !params.requestId) {
    return false;
  }
  return control.consumePlacement({
    placementId: params.placementId,
    requestId: params.requestId,
    ...(params.correlationId !== undefined ? { correlationId: params.correlationId } : {}),
    subject: params.subject,
    source: params.source,
    target: params.target,
    action: params.intent.action,
    resource: params.intent.resource,
    method: params.intent.method,
  });
};

export const revokeRequestIntent = async (env: Env, requestId: string): Promise<RequestIntentRecord | null> => {
  const control = registryStub(env);
  if (!control?.revokeIntent) {
    return null;
  }
  return control.revokeIntent(requestId);
};

export const bumpRequestIntentVersion = async (
  env: Env,
  requestId: string,
): Promise<RequestIntentRecord | null> => {
  const control = registryStub(env);
  if (!control?.bumpIntentVersion) {
    return null;
  }
  return control.bumpIntentVersion(requestId);
};
