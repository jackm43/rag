import { assert, test } from "vitest";

import { createServiceClient, serviceClients } from "../../../packages/auth/client.ts";
import { createServiceServer } from "../../../packages/auth/server.ts";
import {
  decodeReplyJobEnvelope,
  decodeServiceMessage,
  encodeReplyJobEnvelope,
  encodeServiceMessage,
} from "../../../packages/contracts/index.ts";
import type { ServiceMessageBytes } from "../../../packages/contracts/types.ts";
import { buildIdentityContext, mint } from "../../../packages/identity/index.ts";
import { SIGNING_KEY_JWKS, signedServiceMessage } from "../../helpers.ts";

const CHANNEL_ID = "200000000000000001";

const replyEnvelope = () =>
  encodeReplyJobEnvelope(
    { kind: "reply.channel_message", channelId: CHANNEL_ID, content: "hello" },
    { source: "worker" },
  );

const brainSigningKey = () =>
  crypto.subtle.importKey("jwk", SIGNING_KEY_JWKS.brain, { name: "Ed25519" }, false, ["sign"]);

const captureWarnings = () => {
  const original = console.warn;
  const lines: Array<Record<string, unknown>> = [];
  console.warn = (line: unknown) => lines.push(JSON.parse(String(line)));
  return { lines, restore: () => (console.warn = original) };
};

test("a client for an unauthorized hop denies all calls fail-closed", async () => {
  const warnings = captureWarnings();
  try {
    // responder -> brain is not a permitted exchange: Cedar denies on first use.
    const client = createServiceClient({
      self: "responder",
      target: "brain",
      signingKey: brainSigningKey,
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
    // gateway -> brain is authorized, but no signing key was supplied.
    const client = createServiceClient({ self: "gateway", target: "brain", signingKey: null });
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
  const client = createServiceClient({ self: "brain", target: "responder", signingKey: brainSigningKey });
  let captured: ServiceMessageBytes | undefined;
  const queue = { send: async (body: ServiceMessageBytes) => { captured = body; } } as never;

  await client.call({ transport: "queue", queue, envelope: replyEnvelope(), subject: { sub: "user-1" } });
  assert.ok(captured);

  const server = createServiceServer({ self: "responder", expectedIssuers: ["brain"] });
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
    // Forge: claim iss=brain but sign with a freshly generated (non-keyring) key.
    const forgedPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const envelope = replyEnvelope();
    const context = await buildIdentityContext({
      iss: "brain",
      aud: "responder",
      sub: "user-1",
      trustZone: "application",
      envelopeBytes: envelope,
    });
    const forgedToken = await mint(forgedPair.privateKey, context);

    const server = createServiceServer({ self: "responder", expectedIssuers: ["brain"] });
    const denied = await server.receive({ envelope, idToken: forgedToken }, decodeReplyJobEnvelope);
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
      await signedServiceMessage(replyEnvelope(), { iss: "brain", aud: "responder" }),
    );
    assert.ok(valid);
    const replayed = encodeServiceMessage(
      encodeReplyJobEnvelope(
        { kind: "reply.channel_message", channelId: CHANNEL_ID, content: "swapped" },
        { source: "worker" },
      ),
      valid.idToken,
    );
    const server = createServiceServer({ self: "responder", expectedIssuers: ["brain"] });
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
    const client = createServiceClient({ self: "spend", target: "responder", signingKey: brainSigningKey });
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

test("a queue send without a loadable signing key fails closed via serviceClients", async () => {
  const warnings = captureWarnings();
  try {
    let sent = false;
    const queue = {
      send: async () => {
        sent = true;
      },
    } as never;
    let rejected = false;
    // Env with no BRAIN_SIGNING_KEY: minting is impossible, so the call denies.
    await serviceClients({} as never)
      .brainToResponder.call({
        transport: "queue",
        queue,
        envelope: replyEnvelope(),
        subject: { sub: "user-1" },
      })
      .catch(() => {
        rejected = true;
      });
    assert.equal(rejected, true);
    assert.equal(sent, false);
    const denial = warnings.lines.find((line) => line.message === "service_denied");
    assert.ok(denial);
    assert.equal(denial.reason, "missing_exchange_material");
  } finally {
    warnings.restore();
  }
});
