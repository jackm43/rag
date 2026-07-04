import { assert, test } from "vitest";

import type { EntityJson } from "@cedar-policy/cedar-wasm/web";
import { createServiceServer } from "@rag/service-kit/server";
import { createServiceClientFromEnv } from "@rag/service-kit/client";
import { decodeAiSpendJobEnvelope, decodeReplyJobEnvelope, encodeAiSpendJobEnvelope, encodeReplyJobEnvelope } from "@rag/bot/contracts";
import { encodeManifestSnapshot, encodeServiceMessage } from "@rag/contracts-core";
import type { InteractionEditReplyJob } from "@rag/bot/contracts";
import type { ServiceMessageBytes } from "@rag/contracts-core";
import { mintServiceToken, signedServiceMessage, SIGNING_KEY_JWKS } from "../../helpers";

const CHANNEL_ID = "200000000000000001";
const APPLICATION_ID = "500000000000000001";

const captureWarnings = () => {
  const original = console.warn;
  const lines: Array<Record<string, unknown>> = [];
  console.warn = (line: unknown) => {
    lines.push(JSON.parse(String(line)));
  };
  return { lines, restore: () => (console.warn = original) };
};

const replyEnvelope = () =>
  encodeReplyJobEnvelope(
    { kind: "reply.channel_message", channelId: CHANNEL_ID, content: "hello" },
    { source: "worker" },
  );

const workflowsEnv = () =>
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

const responderServer = () =>
  createServiceServer({
    self: "responder",
    expectedIssuers: ["workflows"],
    entities: async () => workflowsResponderEntities(),
  });

test("an application-trusted client sends a signed envelope and preserves subject context", async () => {
  const sent: Array<{ body: ServiceMessageBytes; options?: { delaySeconds?: number } }> = [];
  const queue = {
    send: async (body: ServiceMessageBytes, options?: { delaySeconds?: number }) => {
      sent.push({ body, options });
    },
  } as never;
  const envelope = replyEnvelope();

  await createServiceClientFromEnv(workflowsEnv(), {
    self: "workflows",
    target: "responder",
    transportTrust: "application",
  }).call({
    transport: "queue",
    queue,
    envelope,
    subject: { sub: "user-1" },
  });
  assert.equal(sent.length, 1);
  assert.notDeepEqual(sent[0].body, envelope);

  const received = await responderServer().receive(sent[0].body, decodeReplyJobEnvelope);
  assert.ok(received);
  assert.deepEqual(received.payload, {
    kind: "reply.channel_message",
    channelId: CHANNEL_ID,
    content: "hello",
  });
  assert.equal(received.context.subject, "user-1");
  assert.deepEqual(received.context.delegates, ["workflows"]);
  assert.equal(received.context.source, "workflows");
  assert.equal(received.context.target, "responder");
  assert.equal(received.context.zone, "application");
  assert.equal(received.context.transport, "queue");
});

test("receive denies a raw or object-shaped message before identity verification", async () => {
  const warnings = captureWarnings();
  try {
    const denied = await responderServer().receive({ envelope: replyEnvelope() }, decodeReplyJobEnvelope);
    assert.equal(denied, null);
    const denial = warnings.lines.find((line) => line.message === "service_denied");
    assert.ok(denial);
    assert.equal(denial.zone, "application");
    assert.equal(denial.transport, "queue");
    assert.equal(denial.reason, "body_unparseable");
  } finally {
    warnings.restore();
  }
});

test("receive denies an invalid inner envelope even under a valid token", async () => {
  const warnings = captureWarnings();
  try {
    const garbage = new Uint8Array([1, 2, 3, 4, 5]);
    const message = encodeServiceMessage(
      garbage,
      await mintServiceToken(garbage, { iss: "workflows", aud: "responder" }),
    );
    const invalid = await responderServer().receive(message, decodeReplyJobEnvelope);
    assert.equal(invalid, null);
    const denial = warnings.lines.find((line) => line.message === "service_denied");
    assert.ok(denial);
    assert.equal(denial.reason, "body_unparseable");
  } finally {
    warnings.restore();
  }
});

test("receive denies a token minted for a different envelope (replay)", async () => {
  const warnings = captureWarnings();
  try {
    const token = await mintServiceToken(replyEnvelope(), { iss: "workflows", aud: "responder" });
    const forged = encodeServiceMessage(
      encodeReplyJobEnvelope(
        { kind: "reply.channel_message", channelId: CHANNEL_ID, content: "different" },
        { source: "worker" },
      ),
      token,
    );
    // Over http (the only externally reachable transport) the token is verified;
    // binding/queue are capability-trusted and read claims without a signature.
    const denied = await responderServer().receive(forged, decodeReplyJobEnvelope, "http");
    assert.equal(denied, null);
    const denial = warnings.lines.find((line) => line.message === "service_denied");
    assert.ok(denial);
    assert.equal(denial.reason, "identity_envelope_mismatch");
  } finally {
    warnings.restore();
  }
});

test("receive denies a token addressed to another service", async () => {
  const warnings = captureWarnings();
  try {
    const message = await signedServiceMessage(replyEnvelope(), { iss: "workflows", aud: "spend" });
    // http verifies the token; aud mismatch is denied there.
    const denied = await responderServer().receive(message, decodeReplyJobEnvelope, "http");
    assert.equal(denied, null);
    const denial = warnings.lines.find((line) => line.message === "service_denied");
    assert.ok(denial);
    assert.equal(denial.reason, "identity_aud_mismatch");
  } finally {
    warnings.restore();
  }
});

test("the forwarding authorizer drops a verified hop that policy does not permit", async () => {
  const warnings = captureWarnings();
  try {
    // gateway -> spend verifies cryptographically (real key, correct aud) and
    // carries a registered spend operation, so it clears the registration
    // gate — but no service.invoke policy permits the pair, so the request
    // exits at the authorizer.
    const server = createServiceServer({ self: "spend", expectedIssuers: ["gateway", "workflows"] });
    const envelope = encodeAiSpendJobEnvelope({ spendEventId: "event-1" }, { source: "worker" });
    const message = await signedServiceMessage(envelope, { iss: "gateway", aud: "spend" });
    const denied = await server.receive(message, decodeAiSpendJobEnvelope);
    assert.equal(denied, null);
    const denial = warnings.lines.find((line) => line.message === "service_denied");
    assert.ok(denial);
    assert.equal(denial.identity, "gateway");
    assert.equal(denial.reason, "not_authorized");
  } finally {
    warnings.restore();
  }
});

test("binding transport verifies the token then re-validates the envelope kind", async () => {
  const decodeInteractionEdit = (bytes: Uint8Array): InteractionEditReplyJob | null => {
    const job = decodeReplyJobEnvelope(bytes);
    return job?.kind === "reply.interaction_edit" ? job : null;
  };
  const envelope = encodeReplyJobEnvelope(
    {
      kind: "reply.interaction_edit",
      applicationId: APPLICATION_ID,
      interactionToken: "interaction-token",
      content: "hello",
    },
    { source: "worker" },
  );
  const received = await responderServer().receive(
    encodeServiceMessage(envelope, await mintServiceToken(envelope, { iss: "workflows", aud: "responder" })),
    decodeInteractionEdit,
    "binding",
  );
  assert.equal(received?.payload.kind, "reply.interaction_edit");
  assert.equal(received?.payload.applicationId, APPLICATION_ID);
  assert.equal(received?.context.transport, "binding");

  // A channel-message envelope verifies but is the wrong kind for this hop.
  const warnings = captureWarnings();
  try {
    const channel = replyEnvelope();
    const wrongKind = await responderServer().receive(
      encodeServiceMessage(channel, await mintServiceToken(channel, { iss: "workflows", aud: "responder" })),
      decodeInteractionEdit,
      "binding",
    );
    assert.equal(wrongKind, null);
    const denial = warnings.lines.find((line) => line.message === "service_denied");
    assert.ok(denial);
    assert.equal(denial.transport, "binding");
    assert.equal(denial.reason, "envelope_invalid");
  } finally {
    warnings.restore();
  }
});
