import { REGISTRY_APPLICATION_ID_PATTERN } from "./types";

// The control-plane GRANT side of the per-application authority. Where mint()
// is the hot, synchronous, envelope-bound per-hop path, GRANTING (registering a
// client to act as an application, or revoking it) is slow and lifecycle-shaped:
// the production attestation that authorizes a registration arrives via the
// GitHub webhook AFTER CI, so a request may not be satisfiable at the moment it
// is made. Rather than hard-fail `not_attested`, a grant request rides a durable
// control-plane queue and the authority DO can WAIT for the attestation — it
// records the request as pending and promotes it once the attestation lands.
//
// The request id doubles as the idempotency key and the result-channel handle:
// the authority claims on it (a re-delivered request returns the existing state
// instead of reprocessing), and the client polls grantStatus(id) for the live
// state. See ApplicationAuthority.submitGrant / alarm / grantStatus.
export const GRANT_REQUEST_KINDS = ["grant.register", "grant.revoke"] as const;
export type GrantRequestKind = (typeof GRANT_REQUEST_KINDS)[number];

// The attested artifact a registration stakes its authority on: the exact repo
// path + content hash a production attestation must cover. Structurally the
// authority's RegistrationArtifact.
export type GrantArtifact = { repository: string; path: string; sha256: string };

export type GrantRequest = {
  // Idempotency key + result-channel handle. The authority claims on this id;
  // a re-delivered request returns the existing state rather than reprocessing.
  id: string;
  kind: GrantRequestKind;
  // The application being acted as (the authority DO's own identity).
  appId: string;
  // The client being registered to / revoked from acting as the application.
  client: string;
  // Required for grant.register — the artifact whose production attestation
  // authorizes the registration. Absent for grant.revoke.
  artifact?: GrantArtifact;
  // On-behalf-of subject carried onto the minted token's `sub`; act-as the
  // application itself when omitted.
  subject?: string;
};

// The live state of a grant request, as read from the authority. `pending`
// means the request is durably waiting for its attestation; `rejected` carries
// the reason it can never be satisfied (bad request, or attestation timeout).
export type GrantState = "granted" | "pending" | "revoked" | "rejected" | "unknown";

export type GrantStatusResult = {
  status: GrantState;
  requestId: string;
  appId?: string;
  client?: string;
  kind?: GrantRequestKind;
  reason?: string;
  attempts?: number;
  updatedAt?: string;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export const isGrantArtifact = (value: unknown): value is GrantArtifact => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    isNonEmptyString(record.repository) &&
    isNonEmptyString(record.path) &&
    typeof record.sha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(record.sha256)
  );
};

export const isGrantRequest = (value: unknown): value is GrantRequest => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    !isNonEmptyString(record.id) ||
    !isNonEmptyString(record.kind) ||
    !GRANT_REQUEST_KINDS.includes(record.kind as GrantRequestKind) ||
    !isNonEmptyString(record.appId) ||
    !REGISTRY_APPLICATION_ID_PATTERN.test(record.appId) ||
    !isNonEmptyString(record.client) ||
    !REGISTRY_APPLICATION_ID_PATTERN.test(record.client) ||
    (record.subject !== undefined && !isNonEmptyString(record.subject))
  ) {
    return false;
  }
  // grant.register must carry the attested artifact; grant.revoke must not.
  if (record.kind === "grant.register") {
    return isGrantArtifact(record.artifact);
  }
  return record.artifact === undefined;
};

// The minimal producer shape of a Cloudflare Queue binding — a control-plane
// grant enqueue is all this side needs, so callers depend on nothing heavier.
export type GrantQueue = { send: (body: unknown) => Promise<void> };

// Enqueue a grant request onto the control-plane queue, returning the request
// id the caller polls grantStatus(id) with. The id is caller-supplied for
// idempotency, or generated here for a fresh request. Throws on a malformed
// request rather than enqueueing something the authority will only reject.
export const enqueueGrantRequest = async (
  queue: GrantQueue,
  input: Omit<GrantRequest, "id"> & { id?: string },
): Promise<string> => {
  const request: GrantRequest = { ...input, id: input.id ?? crypto.randomUUID() };
  if (!isGrantRequest(request)) {
    throw new Error("invalid_grant_request");
  }
  await queue.send(request);
  return request.id;
};
