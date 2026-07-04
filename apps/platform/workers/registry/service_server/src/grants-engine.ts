import type {
  GrantArtifact,
  GrantRequest,
  GrantRequestKind,
  GrantState,
  GrantStatusResult,
} from "../../../../lib/registry-kit/grants";

// The event-driven grant state machine, extracted from the ApplicationAuthority
// DO as pure logic over a minimal storage + a handful of injected effects. The
// DO is a thin adapter (it validates the request, binds the app id, and wires
// these deps to its own ctx.storage / attestation / member writes); everything
// interesting — the idempotency claim, the register-now-or-wait decision, the
// alarm-driven promotion, and retention sweeping — lives here so it can be
// exercised without constructing a real Durable Object.

// Grant-record keys. The record under GRANT_PREFIX is both the idempotency claim
// marker and the result-channel state a client polls; PENDING_PREFIX indexes the
// register requests still awaiting attestation so the sweep re-checks only those.
export const GRANT_PREFIX = "grant:";
export const PENDING_PREFIX = "pending:";

// How often the sweep re-checks a pending registration's attestation — the
// attestation arrives via the GitHub webhook after CI, so minutes is right.
export const GRANT_RETRY_MS = 60 * 1000;
// How long a registration waits for its attestation before it is rejected as
// timed out. CI + delivery is minutes; a day bounds one that will never land.
export const GRANT_PENDING_MAX_MS = 24 * 60 * 60 * 1000;
// How long a terminal grant record is retained for the client to poll before
// the sweep reclaims it — the grant itself lives in the member set, so this
// only governs result-channel visibility.
export const GRANT_RETENTION_MS = 60 * 60 * 1000;

// The durable record of one grant request. `submittedAtMs` bounds the wait;
// `completedAtMs` (set on a terminal transition) drives retention sweeping.
export type GrantRecord = {
  id: string;
  kind: GrantRequestKind;
  appId: string;
  client: string;
  subject?: string;
  artifact?: GrantArtifact;
  status: Exclude<GrantState, "unknown">;
  reason?: string;
  attempts: number;
  submittedAtMs: number;
  completedAtMs?: number;
  updatedAt: string;
};

// The slice of DurableObjectState.storage the engine touches.
export interface GrantStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean> | Promise<void>;
  list<T>(options?: { prefix?: string }): Promise<Map<string, T>>;
  setAlarm(time: number): Promise<void>;
}

// The effects the engine defers to the DO: verifying an attestation, and the
// member writes (which also ensure the app's signing key). appId is already
// bound by the DO, so recordMember/revokeMember carry only the client.
export interface GrantDeps {
  storage: GrantStorage;
  isAttested(artifact: GrantArtifact): Promise<boolean>;
  recordMember(client: string, artifact: GrantArtifact, subject?: string): Promise<void>;
  revokeMember(client: string): Promise<void>;
  now(): number;
}

const grantStatusFrom = (record: GrantRecord): GrantStatusResult => ({
  status: record.status,
  requestId: record.id,
  appId: record.appId,
  client: record.client,
  kind: record.kind,
  ...(record.reason ? { reason: record.reason } : {}),
  attempts: record.attempts,
  updatedAt: record.updatedAt,
});

const persist = async (deps: GrantDeps, record: GrantRecord): Promise<GrantStatusResult> => {
  await deps.storage.put(`${GRANT_PREFIX}${record.id}`, record);
  return grantStatusFrom(record);
};

// Claim a grant request idempotently on its id, then apply it. A register whose
// attestation is not yet on record is recorded as pending (never rejected) and
// the sweep promotes it once the attestation lands.
export const submitGrant = async (
  deps: GrantDeps,
  appId: string,
  request: GrantRequest,
): Promise<GrantStatusResult> => {
  const existing = await deps.storage.get<GrantRecord>(`${GRANT_PREFIX}${request.id}`);
  if (existing) {
    return grantStatusFrom(existing);
  }

  const now = deps.now();
  const base: GrantRecord = {
    id: request.id,
    kind: request.kind,
    appId,
    client: request.client,
    ...(request.subject ? { subject: request.subject } : {}),
    ...(request.artifact ? { artifact: request.artifact } : {}),
    status: "pending",
    attempts: 0,
    submittedAtMs: now,
    updatedAt: new Date(now).toISOString(),
  };

  if (request.kind === "grant.revoke") {
    await deps.revokeMember(request.client);
    return persist(deps, { ...base, status: "revoked", completedAtMs: now });
  }

  if (request.artifact && (await deps.isAttested(request.artifact))) {
    await deps.recordMember(request.client, request.artifact, request.subject);
    return persist(deps, { ...base, status: "granted", attempts: 1, completedAtMs: now });
  }

  await deps.storage.put(`${PENDING_PREFIX}${request.id}`, request.id);
  await deps.storage.setAlarm(now + GRANT_RETRY_MS);
  return persist(deps, { ...base, status: "pending", reason: "awaiting_attestation" });
};

// The result channel: the live state of a grant request. Unknown ids — never
// submitted, or already swept after retention — read as "unknown".
export const grantStatus = async (
  deps: GrantDeps,
  requestId: string,
): Promise<GrantStatusResult> => {
  const record = await deps.storage.get<GrantRecord>(`${GRANT_PREFIX}${requestId}`);
  return record ? grantStatusFrom(record) : { status: "unknown", requestId };
};

// The alarm body: promote pending registrations whose attestation has landed
// (or reject those that waited too long), and sweep terminal records past their
// retention window. Returns whether any registration is still pending, so the
// DO reschedules the alarm only while there is something left to wait for. It
// never touches signing material or the member set beyond recordMember.
export const sweepGrants = async (deps: GrantDeps): Promise<boolean> => {
  const now = deps.now();
  let pendingRemain = false;

  const pending = await deps.storage.list<string>({ prefix: PENDING_PREFIX });
  for (const [pendingKey, requestId] of pending) {
    const record = await deps.storage.get<GrantRecord>(`${GRANT_PREFIX}${requestId}`);
    if (!record || record.status !== "pending" || record.kind !== "grant.register" || !record.artifact) {
      await deps.storage.delete(pendingKey);
      continue;
    }
    const attempts = record.attempts + 1;
    const updatedAt = new Date(now).toISOString();
    if (await deps.isAttested(record.artifact)) {
      await deps.recordMember(record.client, record.artifact, record.subject);
      await deps.storage.put(`${GRANT_PREFIX}${requestId}`, {
        ...record,
        status: "granted",
        attempts,
        completedAtMs: now,
        updatedAt,
      } satisfies GrantRecord);
      await deps.storage.delete(pendingKey);
    } else if (now - record.submittedAtMs > GRANT_PENDING_MAX_MS) {
      await deps.storage.put(`${GRANT_PREFIX}${requestId}`, {
        ...record,
        status: "rejected",
        reason: "attestation_timeout",
        attempts,
        completedAtMs: now,
        updatedAt,
      } satisfies GrantRecord);
      await deps.storage.delete(pendingKey);
    } else {
      await deps.storage.put(`${GRANT_PREFIX}${requestId}`, {
        ...record,
        attempts,
        updatedAt,
      } satisfies GrantRecord);
      pendingRemain = true;
    }
  }

  const all = await deps.storage.list<GrantRecord>({ prefix: GRANT_PREFIX });
  for (const [grantKey, record] of all) {
    if (
      record.status !== "pending" &&
      record.completedAtMs !== undefined &&
      now - record.completedAtMs > GRANT_RETENTION_MS
    ) {
      await deps.storage.delete(grantKey);
    }
  }

  return pendingRemain;
};
