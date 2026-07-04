import { assert, test } from "vitest";

import type { EntityJson } from "@cedar-policy/cedar-wasm/web";
import { createServiceClient, createServiceClientFromEnv } from "../../../packages/auth/client.ts";
import { bumpRequestIntentVersion, revokeRequestIntent } from "../../../packages/auth/control-plane.ts";
import { createServiceServer } from "../../../packages/auth/server.ts";
import {
  decodeReplyJobEnvelope,
  decodeServiceMessage,
  encodeManifestSnapshot,
  encodeReplyJobEnvelope,
  encodeServiceMessage,
} from "../../../packages/contracts/index.ts";
import type { ServiceMessageBytes } from "../../../packages/contracts/types.ts";
import { buildIdentityContext, mint } from "../../../packages/identity/index.ts";
import { SIGNING_KEY_JWKS, signedServiceMessage } from "../../helpers.ts";
import type { MachinePrincipal } from "../../../packages/auth/principal.ts";

const CHANNEL_ID = "200000000000000001";

const replyEnvelope = () =>
  encodeReplyJobEnvelope(
    { kind: "reply.channel_message", channelId: CHANNEL_ID, content: "hello" },
    { source: "worker" },
  );

const workflowsSigningKey = () =>
  crypto.subtle.importKey("jwk", SIGNING_KEY_JWKS.workflows, { name: "Ed25519" }, false, ["sign"]);

const workflowsResponderEntities = (): EntityJson[] => [
  {
    uid: { type: "Application", id: "workflows" },
    attrs: {
      zone: "application",
      plane: "data",
      targets: [{ __entity: { type: "Application", id: "responder" } }],
      operations: [],
    },
    parents: [],
  },
  {
    uid: { type: "Application", id: "responder" },
    attrs: {
      zone: "application",
      plane: "data",
      operations: ["reply.channel_message", "reply.interaction_edit"],
      targets: [],
    },
    parents: [],
  },
  {
    uid: { type: "Service", id: "responder:reply.channel_message" },
    attrs: {
      application: { __entity: { type: "Application", id: "responder" } },
      zone: "application",
      plane: "data",
      operation: "reply.channel_message",
      clients: [{ __entity: { type: "Application", id: "workflows" } }],
    },
    parents: [],
  },
  {
    uid: { type: "Service", id: "responder:reply.interaction_edit" },
    attrs: {
      application: { __entity: { type: "Application", id: "responder" } },
      zone: "application",
      plane: "data",
      operation: "reply.interaction_edit",
      clients: [{ __entity: { type: "Application", id: "workflows" } }],
    },
    parents: [],
  },
];

const registryEnv = () =>
  ({
    WORKFLOWS_SIGNING_KEY: JSON.stringify(SIGNING_KEY_JWKS.workflows),
    SERVICE_REGISTRY: {
      idFromName: (name: string) => name,
      get: () => ({
        register: async () => undefined,
        createIntent: async (record: {
          subject: string;
          initiatingApplication: string;
          action: string;
          resource: string;
          method: string;
          allowedApplications: string[];
        }) => ({
          id: "request-1",
          iss: record.iss,
          sub: record.sub,
          aud: record.aud,
          iat: 1,
          nbf: 1,
          exp: 61,
          jti: record.jti,
          correlationId: record.correlationId,
          subject: record.subject,
          initiatingApplication: record.initiatingApplication,
          action: record.action,
          resource: record.resource,
          method: record.method,
          allowedApplications: record.allowedApplications,
          expiresAt: Date.now() + 60_000,
          version: 1,
        }),
        createPlacement: async (record: {
          requestId: string;
          subject: string;
          source: string;
          target: string;
          action: string;
          resource: string;
          method: string;
        }) => ({
          id: "placement-1",
          iss: record.iss,
          sub: record.sub,
          aud: record.aud,
          iat: 1,
          nbf: 1,
          exp: 61,
          jti: record.jti,
          correlationId: record.correlationId,
          requestId: record.requestId,
          subject: record.subject,
          source: record.source,
          target: record.target,
          action: record.action,
          resource: record.resource,
          method: record.method,
          expiresAt: Date.now() + 60_000,
          intentVersion: 1,
        }),
        consumePlacement: async () => true,
        snapshot: async () =>
          encodeManifestSnapshot([
            {
              service: "workflows",
              zone: "application",
              targets: ["responder"],
              operations: [],
              scopes: [],
            },
            {
              service: "responder",
              zone: "application",
              targets: [],
              operations: ["reply.channel_message", "reply.interaction_edit"],
              scopes: [],
            },
          ]),
      }),
    },
  }) as never;

type ControlIntent = {
  id: string;
  iss: MachinePrincipal;
  sub: string;
  aud: MachinePrincipal;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
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

type ControlPlacement = {
  id: string;
  iss: MachinePrincipal;
  sub: string;
  aud: MachinePrincipal;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
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

const controlPlaneEnv = () => {
  const intents = new Map<string, ControlIntent>();
  const placements = new Map<string, ControlPlacement>();
  let now = 1_000;
  let intentSeq = 0;
  let placementSeq = 0;
  const stub = {
    register: async () => undefined,
    snapshot: async () =>
      encodeManifestSnapshot([
        {
          service: "workflows",
          zone: "application",
          targets: ["responder"],
          operations: [],
          scopes: [],
        },
        {
          service: "responder",
          zone: "application",
          targets: [],
          operations: ["reply.channel_message", "reply.interaction_edit"],
          scopes: [],
        },
      ]),
    createIntent: async (
      record: Omit<ControlIntent, "id" | "iat" | "nbf" | "exp" | "expiresAt" | "version"> & {
        ttlMs?: number;
      },
    ) => {
      const expiresAt = now + (record.ttlMs ?? 60_000);
      const intent: ControlIntent = {
        id: `request-${++intentSeq}`,
        iss: record.iss,
        sub: record.sub,
        aud: record.aud,
        iat: Math.floor(now / 1000),
        nbf: Math.floor(now / 1000),
        exp: Math.floor(expiresAt / 1000),
        jti: record.jti,
        correlationId: record.correlationId,
        subject: record.subject,
        initiatingApplication: record.initiatingApplication,
        action: record.action,
        resource: record.resource,
        method: record.method,
        allowedApplications: record.allowedApplications,
        expiresAt,
        version: 1,
      };
      intents.set(intent.id, intent);
      return intent;
    },
    createPlacement: async (
      record: Omit<ControlPlacement, "id" | "iat" | "nbf" | "exp" | "expiresAt" | "intentVersion"> & {
        ttlMs?: number;
      },
    ) => {
      const intent = intents.get(record.requestId);
      if (
        !intent ||
        intent.revokedAt !== undefined ||
        intent.expiresAt <= now ||
        intent.subject !== record.subject ||
        intent.sub !== record.sub ||
        intent.correlationId !== record.correlationId ||
        !intent.allowedApplications.includes(record.target)
      ) {
        return null;
      }
      const expiresAt = now + (record.ttlMs ?? 60_000);
      const placement: ControlPlacement = {
        id: `placement-${++placementSeq}`,
        iss: record.iss,
        sub: record.sub,
        aud: record.aud,
        iat: Math.floor(now / 1000),
        nbf: Math.floor(now / 1000),
        exp: Math.floor(expiresAt / 1000),
        jti: record.jti,
        correlationId: record.correlationId,
        requestId: record.requestId,
        subject: record.subject,
        source: record.source,
        target: record.target,
        action: record.action,
        resource: record.resource,
        method: record.method,
        expiresAt,
        intentVersion: intent.version,
      };
      placements.set(placement.id, placement);
      return placement;
    },
    consumePlacement: async (input: {
      placementId: string;
      requestId: string;
      correlationId?: string;
      subject: string;
      source: MachinePrincipal;
      target: MachinePrincipal;
      action: string;
      resource: string;
      method: string;
    }) => {
      const placement = placements.get(input.placementId);
      if (!placement) {
        return false;
      }
      placements.delete(input.placementId);
      const intent = intents.get(input.requestId);
      return !!intent &&
        intent.revokedAt === undefined &&
        intent.expiresAt > now &&
        intent.version === placement.intentVersion &&
        now >= placement.nbf * 1000 &&
        placement.expiresAt > now &&
        placement.requestId === input.requestId &&
        (input.correlationId === undefined || placement.correlationId === input.correlationId) &&
        placement.subject === input.subject &&
        placement.source === input.source &&
        placement.target === input.target &&
        placement.action === input.action &&
        placement.resource === input.resource &&
        placement.method === input.method &&
        intent.subject === input.subject &&
        intent.sub === input.subject &&
        intent.correlationId === placement.correlationId &&
        intent.allowedApplications.includes(input.target);
    },
    revokeIntent: async (requestId: string) => {
      const intent = intents.get(requestId);
      if (!intent) {
        return null;
      }
      const revoked: ControlIntent = { ...intent, version: intent.version + 1, revokedAt: now };
      intents.set(requestId, revoked);
      return revoked;
    },
    bumpIntentVersion: async (requestId: string) => {
      const intent = intents.get(requestId);
      if (!intent) {
        return null;
      }
      const updated: ControlIntent = { ...intent, version: intent.version + 1 };
      intents.set(requestId, updated);
      return updated;
    },
  };
  const env = {
    WORKFLOWS_SIGNING_KEY: JSON.stringify(SIGNING_KEY_JWKS.workflows),
    SERVICE_REGISTRY: {
      idFromName: (name: string) => name,
      get: () => stub,
    },
  } as never;
  return {
    env,
    intents,
    placements,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

const captureWarnings = () => {
  const original = console.warn;
  const lines: Array<Record<string, unknown>> = [];
  console.warn = (line: unknown) => lines.push(JSON.parse(String(line)));
  return { lines, restore: () => (console.warn = original) };
};

test("a client for an unauthorized hop denies all calls fail-closed", async () => {
  const warnings = captureWarnings();
  try {
    // responder -> workflows is not a permitted exchange: Cedar denies on first use.
    const client = createServiceClient({
      self: "responder",
      target: "workflows",
      signingKey: workflowsSigningKey,
    });
    let sent = false;
    const queue = { send: async () => { sent = true; } } as never;

    let rejected = false;
    await client
      .call({ transport: "queue", queue, envelope: replyEnvelope(), subject: { sub: "user-1" } })
      .catch(() => (rejected = true));
    assert.equal(rejected, true);
    assert.equal(sent, false);
    const denial = warnings.lines.find((line) => line.message === "service_denied");
    assert.equal(denial?.reason, "exchange_not_authorized");
  } finally {
    warnings.restore();
  }
});

test("a hop without signing material denies fail-closed (every hop requires exchange)", async () => {
  const warnings = captureWarnings();
  try {
    // gateway -> workflows is authorized, but no signing key was supplied.
    const client = createServiceClient({ self: "gateway", target: "workflows", signingKey: null });
    let rejected = false;
    await client
      .call({
        transport: "queue",
        queue: { send: async () => undefined } as never,
        envelope: replyEnvelope(),
        subject: { sub: "user-1" },
      })
      .catch(() => (rejected = true));
    assert.equal(rejected, true);
    const denial = warnings.lines.find((line) => line.message === "service_denied");
    assert.equal(denial?.reason, "missing_exchange_material");
  } finally {
    warnings.restore();
  }
});

test("an authorized client with a key mints a token the server verifies end to end", async () => {
  const client = createServiceClient({
    self: "workflows",
    target: "responder",
    signingKey: workflowsSigningKey,
    entities: async () => workflowsResponderEntities(),
  });
  let captured: ServiceMessageBytes | undefined;
  const queue = { send: async (body: ServiceMessageBytes) => { captured = body; } } as never;

  await client.call({ transport: "queue", queue, envelope: replyEnvelope(), subject: { sub: "user-1" } });
  assert.ok(captured);

  const server = createServiceServer({
    self: "responder",
    expectedIssuers: ["workflows"],
    entities: async () => workflowsResponderEntities(),
  });
  const received = await server.receive(captured, decodeReplyJobEnvelope);
  assert.deepEqual(received?.payload, {
    kind: "reply.channel_message",
    channelId: CHANNEL_ID,
    content: "hello",
  });
});

test("a token signed by the wrong key for a real issuer is denied at the server", async () => {
  const warnings = captureWarnings();
  try {
    // Forge: claim iss=workflows but sign with a freshly generated (non-keyring) key.
    const forgedPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const envelope = replyEnvelope();
    const context = await buildIdentityContext({
      iss: "workflows",
      aud: "responder",
      sub: "user-1",
      trustZone: "application",
      envelopeBytes: envelope,
    });
    const forgedToken = await mint(forgedPair.privateKey, context);

    const server = createServiceServer({ self: "responder", expectedIssuers: ["workflows"] });
    const denied = await server.receive(encodeServiceMessage(envelope, forgedToken), decodeReplyJobEnvelope);
    assert.equal(denied, null);
    const denial = warnings.lines.find((line) => line.message === "service_denied");
    assert.equal(denial?.reason, "identity_bad_signature");
  } finally {
    warnings.restore();
  }
});

test("a valid token replayed against different envelope bytes is denied at the server", async () => {
  const warnings = captureWarnings();
  try {
    const valid = decodeServiceMessage(
      await signedServiceMessage(replyEnvelope(), { iss: "workflows", aud: "responder" }),
    );
    assert.ok(valid);
    const replayed = encodeServiceMessage(
      encodeReplyJobEnvelope(
        { kind: "reply.channel_message", channelId: CHANNEL_ID, content: "swapped" },
        { source: "worker" },
      ),
      valid.idToken,
    );
    const server = createServiceServer({ self: "responder", expectedIssuers: ["workflows"] });
    const denied = await server.receive(replayed, decodeReplyJobEnvelope);
    assert.equal(denied, null);
    const denial = warnings.lines.find((line) => line.message === "service_denied");
    assert.equal(denial?.reason, "identity_envelope_mismatch");
  } finally {
    warnings.restore();
  }
});

test("the binding transport also denies an unauthorized hop", async () => {
  const warnings = captureWarnings();
  try {
    // spend -> responder is not a permitted exchange.
    const client = createServiceClient({ self: "spend", target: "responder", signingKey: workflowsSigningKey });
    let rejected = false;
    await client
      .call({
        transport: "binding",
        env: { RESPONDER: { deliverInteractionEdit: async () => undefined } } as never,
        envelope: replyEnvelope(),
        attachment: { name: "x.png", contentType: "image/png", data: new ArrayBuffer(4) },
        subject: { sub: "user-1" },
      })
      .catch(() => (rejected = true));
    assert.equal(rejected, true);
    const denial = warnings.lines.find((line) => line.message === "service_denied");
    assert.equal(denial?.reason, "exchange_not_authorized");
  } finally {
    warnings.restore();
  }
});

test("application-trusted configured service clients require signing material", async () => {
  const warnings = captureWarnings();
  try {
    const envelope = replyEnvelope();
    let rejected = false;
    await createServiceClientFromEnv({} as never, {
      self: "workflows",
      target: "responder",
      transportTrust: "application",
    })
      .call({
        transport: "queue",
        queue: { send: async () => undefined } as never,
        envelope,
        subject: { sub: "user-1" },
      })
      .catch(() => (rejected = true));
    assert.equal(rejected, true);
    const denial = warnings.lines.find((line) => line.message === "service_denied");
    assert.equal(denial?.reason, "missing_exchange_material");
  } finally {
    warnings.restore();
  }
});

test("configured service clients authorize through the registry snapshot", async () => {
  const sent: ServiceMessageBytes[] = [];
  await createServiceClientFromEnv(registryEnv(), {
    self: "workflows",
    target: "responder",
    transportTrust: "application",
  }).call({
      transport: "queue",
      queue: { send: async (body: ServiceMessageBytes) => { sent.push(body); } } as never,
      envelope: replyEnvelope(),
      subject: { sub: "user-1" },
    });
  assert.equal(sent.length, 1);
});

test("control-plane placements are consumed once and deny token replay", async () => {
  const { env } = controlPlaneEnv();
  const sent: ServiceMessageBytes[] = [];
  await createServiceClientFromEnv(env, {
    self: "workflows",
    target: "responder",
    transportTrust: "application",
  }).call({
    transport: "queue",
    queue: { send: async (body: ServiceMessageBytes) => { sent.push(body); } } as never,
    envelope: replyEnvelope(),
    subject: { sub: "user-1" },
  });
  assert.equal(sent.length, 1);

  const server = createServiceServer({ self: "responder", expectedIssuers: ["workflows"], env });
  const first = await server.receive(sent[0], decodeReplyJobEnvelope);
  assert.equal(first?.context.requestId, "request-1");
  assert.equal(first?.context.placementId, "placement-1");
  assert.isString(first?.context.correlationId);
  assert.equal(first?.context.action, "service.invoke");
  assert.equal(first?.context.resource, "responder:reply.channel_message");
  assert.equal(first?.context.method, "reply.channel_message");

  const replay = await server.receive(sent[0], decodeReplyJobEnvelope);
  assert.equal(replay, null);
});

test("control-plane placement expiry denies queued work before domain logic", async () => {
  const { env, advance } = controlPlaneEnv();
  const sent: ServiceMessageBytes[] = [];
  await createServiceClientFromEnv(env, {
    self: "workflows",
    target: "responder",
    transportTrust: "application",
  }).call({
    transport: "queue",
    queue: { send: async (body: ServiceMessageBytes) => { sent.push(body); } } as never,
    envelope: replyEnvelope(),
    subject: { sub: "user-1" },
  });

  advance(91_000);
  const server = createServiceServer({ self: "responder", expectedIssuers: ["workflows"], env });
  const denied = await server.receive(sent[0], decodeReplyJobEnvelope);
  assert.equal(denied, null);
});

test("revoking an intent denies already placed queued work", async () => {
  const { env, intents } = controlPlaneEnv();
  const sent: ServiceMessageBytes[] = [];
  await createServiceClientFromEnv(env, {
    self: "workflows",
    target: "responder",
    transportTrust: "application",
  }).call({
    transport: "queue",
    queue: { send: async (body: ServiceMessageBytes) => { sent.push(body); } } as never,
    envelope: replyEnvelope(),
    subject: { sub: "user-1" },
  });

  const [requestId] = [...intents.keys()];
  const revoked = await revokeRequestIntent(env, requestId);
  assert.equal(revoked?.revokedAt, 1_000);
  assert.equal(revoked?.version, 2);

  const server = createServiceServer({ self: "responder", expectedIssuers: ["workflows"], env });
  const denied = await server.receive(sent[0], decodeReplyJobEnvelope);
  assert.equal(denied, null);
});

test("bumping an intent version denies stale placements but allows new placements", async () => {
  const { env, intents } = controlPlaneEnv();
  const sent: ServiceMessageBytes[] = [];
  const client = createServiceClientFromEnv(env, {
    self: "workflows",
    target: "responder",
    transportTrust: "application",
  });
  await client.call({
    transport: "queue",
    queue: { send: async (body: ServiceMessageBytes) => { sent.push(body); } } as never,
    envelope: replyEnvelope(),
    subject: { sub: "user-1" },
  });

  const [requestId] = [...intents.keys()];
  const correlationId = intents.get(requestId)?.correlationId;
  const updated = await bumpRequestIntentVersion(env, requestId);
  assert.equal(updated?.version, 2);

  const server = createServiceServer({ self: "responder", expectedIssuers: ["workflows"], env });
  const stale = await server.receive(sent[0], decodeReplyJobEnvelope);
  assert.equal(stale, null);

  await client.call({
    transport: "queue",
    queue: { send: async (body: ServiceMessageBytes) => { sent.push(body); } } as never,
    envelope: replyEnvelope(),
    subject: { sub: "user-1", requestId, correlationId },
  });
  const fresh = await server.receive(sent[1], decodeReplyJobEnvelope);
  assert.equal(fresh?.context.requestId, requestId);
  assert.equal(fresh?.context.placementId, "placement-2");
});
