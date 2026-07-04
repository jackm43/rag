import { assert, test } from "vitest";

import type { Env } from "@rag/platform/contracts";
import { processGrantQueueMessage } from "@rag/platform/workers/registry/service_server/src";
import {
  GRANT_PREFIX,
  GRANT_PENDING_MAX_MS,
  grantStatus,
  PENDING_PREFIX,
  submitGrant,
  sweepGrants,
  type GrantDeps,
  type GrantRecord,
} from "@rag/platform/workers/registry/service_server/src/grants-engine";
import type { GrantArtifact, GrantRequest } from "@rag/platform/lib/registry-kit/grants";

// A Map-backed GrantStorage double: enough of DurableObjectState.storage for the
// grant engine (get/put/delete/list-by-prefix + a single alarm slot). The engine
// is pure over these deps, so the state machine is exercised without a live DO.
const makeStorage = () => {
  const map = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    map,
    alarmAt: () => alarm,
    get: async <T>(key: string) => map.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      map.set(key, value);
    },
    delete: async (key: string) => map.delete(key),
    list: async <T>(options?: { prefix?: string }) => {
      const out = new Map<string, T>();
      for (const [key, value] of map) {
        if (!options?.prefix || key.startsWith(options.prefix)) {
          out.set(key, value as T);
        }
      }
      return out;
    },
    setAlarm: async (time: number) => {
      alarm = time;
    },
  };
};

// A grant-deps harness whose attestation verdict is a single mutable flag (so a
// test can flip "not attested" -> "attested" and re-sweep) and whose member
// writes are captured for assertion.
const makeDeps = () => {
  const storage = makeStorage();
  const attested = { ok: false };
  const members: string[] = [];
  const deps: GrantDeps = {
    storage,
    isAttested: async () => attested.ok,
    recordMember: async (client) => {
      if (!members.includes(client)) {
        members.push(client);
      }
    },
    revokeMember: async (client) => {
      const index = members.indexOf(client);
      if (index >= 0) {
        members.splice(index, 1);
      }
    },
    now: () => Date.now(),
  };
  return { deps, storage, attested, members };
};

const ARTIFACT: GrantArtifact = {
  repository: "jackm/rag",
  path: "apps/sample/worker.js",
  sha256: "a".repeat(64),
};

const registerRequest = (overrides: Partial<GrantRequest> = {}): GrantRequest => ({
  id: "req-1",
  kind: "grant.register",
  appId: "sample-app",
  client: "workflows",
  artifact: ARTIFACT,
  ...overrides,
});

test("submitGrant registers immediately when the attestation is already on record", async () => {
  const { deps, storage, attested, members } = makeDeps();
  attested.ok = true;

  const result = await submitGrant(deps, "sample-app", registerRequest());
  assert.equal(result.status, "granted");
  assert.equal(result.requestId, "req-1");
  assert.deepEqual(members, ["workflows"]);
  // A granted registration arms no alarm and leaves no pending index.
  assert.equal(storage.alarmAt(), null);
  assert.deepEqual([...storage.map.keys()].filter((k) => k.startsWith(PENDING_PREFIX)), []);
});

test("submitGrant waits durably for the attestation, then the sweep promotes it", async () => {
  const { deps, storage, attested, members } = makeDeps();

  const pending = await submitGrant(deps, "sample-app", registerRequest());
  assert.equal(pending.status, "pending");
  assert.equal(pending.reason, "awaiting_attestation");
  assert.deepEqual(members, []);
  // Pending arms the alarm and indexes the request for the sweep.
  assert.isNumber(storage.alarmAt());
  assert.deepEqual([...storage.map.keys()].filter((k) => k.startsWith(PENDING_PREFIX)), [`${PENDING_PREFIX}req-1`]);

  // The attestation lands (via the GitHub webhook) after the request was made.
  attested.ok = true;
  const stillPending = await sweepGrants(deps);
  assert.isFalse(stillPending);

  const promoted = await grantStatus(deps, "req-1");
  assert.equal(promoted.status, "granted");
  assert.deepEqual(members, ["workflows"]);
  assert.deepEqual([...storage.map.keys()].filter((k) => k.startsWith(PENDING_PREFIX)), []);
});

test("submitGrant is idempotent on the request id — a redelivery grants once", async () => {
  const { deps, members } = makeDeps();
  deps.isAttested = async () => true;

  const first = await submitGrant(deps, "sample-app", registerRequest());
  const second = await submitGrant(deps, "sample-app", registerRequest());
  assert.equal(first.status, "granted");
  assert.equal(second.status, "granted");
  assert.deepEqual(members, ["workflows"]);
});

test("a still-pending redelivery does not duplicate the pending index", async () => {
  const { deps, storage } = makeDeps();

  await submitGrant(deps, "sample-app", registerRequest());
  await submitGrant(deps, "sample-app", registerRequest());

  const pendingKeys = [...storage.map.keys()].filter((key) => key.startsWith(PENDING_PREFIX));
  assert.deepEqual(pendingKeys, [`${PENDING_PREFIX}req-1`]);
});

test("submitGrant revoke removes the member", async () => {
  const { deps, attested, members } = makeDeps();
  attested.ok = true;
  await submitGrant(deps, "sample-app", registerRequest());
  assert.deepEqual(members, ["workflows"]);

  const revoked = await submitGrant(deps, "sample-app", {
    id: "req-2",
    kind: "grant.revoke",
    appId: "sample-app",
    client: "workflows",
  });
  assert.equal(revoked.status, "revoked");
  assert.deepEqual(members, []);
});

test("the sweep rejects a registration that waited past the maximum window", async () => {
  const { deps, storage } = makeDeps();
  await submitGrant(deps, "sample-app", registerRequest());

  // Age the pending record beyond the ceiling; attestation never lands.
  const record = storage.map.get(`${GRANT_PREFIX}req-1`) as GrantRecord;
  record.submittedAtMs = Date.now() - GRANT_PENDING_MAX_MS - 1000;
  storage.map.set(`${GRANT_PREFIX}req-1`, record);

  const stillPending = await sweepGrants(deps);
  assert.isFalse(stillPending);

  const status = await grantStatus(deps, "req-1");
  assert.equal(status.status, "rejected");
  assert.equal(status.reason, "attestation_timeout");
});

test("grantStatus reads unknown for a request id never submitted", async () => {
  const { deps } = makeDeps();
  const status = await grantStatus(deps, "never-seen");
  assert.equal(status.status, "unknown");
});

test("the grant consumer dispatches a valid request to the authority and acks", async () => {
  let submitted: GrantRequest | null = null;
  const env = {
    APPLICATION_AUTHORITY: {
      idFromName: (name: string) => name,
      get: () => ({
        submitGrant: async (request: GrantRequest) => {
          submitted = request;
          return { status: "pending", requestId: request.id };
        },
      }),
    },
  } as unknown as Env;

  let acked = false;
  let retried = false;
  await processGrantQueueMessage(
    {
      body: registerRequest(),
      ack: () => {
        acked = true;
      },
      retry: () => {
        retried = true;
      },
    } as unknown as Message<unknown>,
    env,
  );

  assert.isTrue(acked);
  assert.isFalse(retried);
  assert.equal((submitted as GrantRequest | null)?.id, "req-1");
});

test("the grant consumer acks (drops) a malformed message rather than wedging the queue", async () => {
  let acked = false;
  let dispatched = false;
  const env = {
    APPLICATION_AUTHORITY: {
      idFromName: (name: string) => name,
      get: () => ({
        submitGrant: async () => {
          dispatched = true;
          return { status: "pending", requestId: "x" };
        },
      }),
    },
  } as unknown as Env;

  await processGrantQueueMessage(
    {
      body: { id: "x", kind: "nonsense" },
      ack: () => {
        acked = true;
      },
      retry: () => {},
    } as unknown as Message<unknown>,
    env,
  );

  assert.isTrue(acked);
  assert.isFalse(dispatched);
});
