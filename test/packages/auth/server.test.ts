import { assert, test } from "vitest";

import { createServiceServer } from "../../../packages/auth/server.ts";
import { serviceClients } from "../../../packages/auth/client.ts";
import {
  decodeAiSpendJobEnvelope,
  decodeReplyJobEnvelope,
  decodeServiceMessage,
  encodeAiSpendJobEnvelope,
  encodeReplyJobEnvelope,
  encodeServiceMessage,
} from "../../../packages/contracts/index.ts";
import type { InteractionEditReplyJob, ServiceMessageBytes } from "../../../packages/contracts/types.ts";
import { mintServiceToken, signedServiceMessage, SIGNING_KEY_JWKS } from "../../helpers.ts";

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

const brainEnv = () =>
  ({
    BRAIN_SIGNING_KEY: JSON.stringify(SIGNING_KEY_JWKS.brain),
  }) as never;

const responderServer = () =>
  createServiceServer({ self: "responder", expectedIssuers: ["brain"] });

test("a client mints a token beside the envelope and the server verifies it into a request context", async () => {
  const sent: Array<{ body: ServiceMessageBytes; options?: { delaySeconds?: number } }> = [];
  const queue = {
    send: async (body: ServiceMessageBytes, options?: { delaySeconds?: number }) => {
      sent.push({ body, options });
    },
  } as never;
  const envelope = replyEnvelope();

  await serviceClients(brainEnv()).brainToResponder.call({
    transport: "queue",
    queue,
    envelope,
    subject: { sub: "user-1" },
  });
  assert.equal(sent.length, 1);
  // The queue body is capnp ServiceMessage bytes framing the envelope + JWS.
  const wire = decodeServiceMessage(sent[0].body);
  assert.ok(wire);
  assert.deepEqual(wire.envelope, envelope);
  assert.isString(wire.idToken);

  const received = await responderServer().receive(sent[0].body, decodeReplyJobEnvelope);
  assert.ok(received);
  assert.deepEqual(received.payload, {
    kind: "reply.channel_message",
    channelId: CHANNEL_ID,
    content: "hello",
  });
  // The verified context carries the subject and delegation chain.
  assert.equal(received.context.subject, "user-1");
  assert.deepEqual(received.context.delegates, ["brain"]);
  assert.equal(received.context.source, "brain");
  assert.equal(received.context.target, "responder");
  assert.equal(received.context.zone, "application");
  assert.equal(received.context.transport, "queue");
});

test("receive denies a message with no identity token", async () => {
  const warnings = captureWarnings();
  try {
    const denied = await responderServer().receive({ envelope: replyEnvelope() }, decodeReplyJobEnvelope);
    assert.equal(denied, null);
    const denial = warnings.lines.find((line) => line.message === "service_denied");
    assert.ok(denial);
    assert.equal(denial.zone, "application");
    assert.equal(denial.transport, "queue");
    assert.equal(denial.reason, "identity_missing");
  } finally {
    warnings.restore();
  }
});

test("receive denies an invalid envelope even under a valid token", async () => {
  const warnings = captureWarnings();
  try {
    // Legacy object wrapper (still accepted for in-flight messages).
    const garbage = new Uint8Array([1, 2, 3, 4, 5]);
    const message = {
      envelope: garbage,
      idToken: await mintServiceToken(garbage, { iss: "brain", aud: "responder" }),
    };
    const invalid = await responderServer().receive(message, decodeReplyJobEnvelope);
    assert.equal(invalid, null);
    const denial = warnings.lines.find((line) => line.message === "service_denied");
    assert.ok(denial);
    // Malformed bytes carry no readable operation, so the registration gate
    // refuses them before any decode runs.
    assert.equal(denial.reason, "operation_unregistered");
  } finally {
    warnings.restore();
  }
});

test("receive denies a token minted for a different envelope (replay)", async () => {
  const warnings = captureWarnings();
  try {
    const token = await mintServiceToken(replyEnvelope(), { iss: "brain", aud: "responder" });
    const forged = encodeServiceMessage(
      encodeReplyJobEnvelope(
        { kind: "reply.channel_message", channelId: CHANNEL_ID, content: "different" },
        { source: "worker" },
      ),
      token,
    );
    const denied = await responderServer().receive(forged, decodeReplyJobEnvelope);
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
    const message = await signedServiceMessage(replyEnvelope(), { iss: "brain", aud: "spend" });
    const denied = await responderServer().receive(message, decodeReplyJobEnvelope);
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
    const server = createServiceServer({ self: "spend", expectedIssuers: ["gateway", "brain"] });
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
    { envelope, idToken: await mintServiceToken(envelope, { iss: "brain", aud: "responder" }) },
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
      { envelope: channel, idToken: await mintServiceToken(channel, { iss: "brain", aud: "responder" }) },
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
