import { assert, test } from "vitest";

import {
  createPeerBindingSender,
  createPeerQueueSender,
} from "../../../../packages/boundaries/peer/exchange.ts";
import { peerReceive } from "../../../../packages/boundaries/peer/queue.ts";
import { peerDeliveryAuthorize } from "../../../../packages/authz/peer.ts";
import {
  decodeReplyJobEnvelope,
  encodeReplyJobEnvelope,
} from "../../../../packages/contracts/index.ts";
import type { PeerQueueMessage } from "../../../../packages/contracts/types.ts";
import {
  buildIdentityContext,
  mint,
} from "../../../../packages/identity/index.ts";
import { SIGNING_KEY_JWKS, signedPeerMessage } from "../../../helpers.ts";

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

test("constructing a peer client for an unauthorized hop denies all sends at build time", async () => {
  const warnings = captureWarnings();
  try {
    // responder -> brain is not a permitted exchange: Cedar denies at construction.
    const sender = createPeerQueueSender({
      self: "responder",
      target: "brain",
      signingKey: brainSigningKey,
    });
    let sent = false;
    const queue = { send: async () => { sent = true; } } as never;

    let rejected = false;
    await sender.send(queue, replyEnvelope(), { sub: "user-1" }).catch(() => (rejected = true));
    assert.equal(rejected, true);
    assert.equal(sent, false);
    const denial = warnings.lines.find((line) => line.message === "peer_denied");
    assert.equal(denial?.reason, "exchange_not_authorized");
  } finally {
    warnings.restore();
  }
});

test("a trust-zone transition without signing material denies at construction", async () => {
  const warnings = captureWarnings();
  try {
    // gateway -> brain is authorized, but no signing key was supplied.
    const sender = createPeerQueueSender({ self: "gateway", target: "brain", signingKey: null });
    let rejected = false;
    await sender
      .send({ send: async () => undefined } as never, replyEnvelope(), { sub: "user-1" })
      .catch(() => (rejected = true));
    assert.equal(rejected, true);
    const denial = warnings.lines.find((line) => line.message === "peer_denied");
    assert.equal(denial?.reason, "missing_exchange_material");
  } finally {
    warnings.restore();
  }
});

test("an authorized construction with a key mints a token the receiver verifies end to end", async () => {
  const sender = createPeerQueueSender({ self: "brain", target: "responder", signingKey: brainSigningKey });
  let captured: PeerQueueMessage | undefined;
  const queue = { send: async (body: PeerQueueMessage) => { captured = body; } } as never;

  await sender.send(queue, replyEnvelope(), { sub: "user-1" });
  assert.ok(captured);

  const decoded = await peerReceive(captured, decodeReplyJobEnvelope, {
    self: "responder",
    expectedIssuers: ["brain"],
    authorize: peerDeliveryAuthorize("responder"),
  });
  assert.deepEqual(decoded, { kind: "reply.channel_message", channelId: CHANNEL_ID, content: "hello" });
});

test("a token signed by the wrong key for a real issuer is denied at the receiver", async () => {
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
      trustZone: "brain",
      envelopeBytes: envelope,
    });
    const forgedToken = await mint(forgedPair.privateKey, context);

    const denied = await peerReceive({ envelope, idToken: forgedToken }, decodeReplyJobEnvelope, {
      self: "responder",
      expectedIssuers: ["brain"],
    });
    assert.equal(denied, null);
    const denial = warnings.lines.find((line) => line.message === "peer_denied");
    assert.equal(denial?.reason, "identity_bad_signature");
  } finally {
    warnings.restore();
  }
});

test("a valid token replayed against different envelope bytes is denied at the receiver", async () => {
  const warnings = captureWarnings();
  try {
    const valid = await signedPeerMessage(replyEnvelope(), { iss: "brain", aud: "responder" });
    const replayed: PeerQueueMessage = {
      envelope: encodeReplyJobEnvelope(
        { kind: "reply.channel_message", channelId: CHANNEL_ID, content: "swapped" },
        { source: "worker" },
      ),
      idToken: valid.idToken,
    };
    const denied = await peerReceive(replayed, decodeReplyJobEnvelope, {
      self: "responder",
      expectedIssuers: ["brain"],
    });
    assert.equal(denied, null);
    const denial = warnings.lines.find((line) => line.message === "peer_denied");
    assert.equal(denial?.reason, "identity_envelope_mismatch");
  } finally {
    warnings.restore();
  }
});

test("createPeerBindingSender also denies an unauthorized construction", async () => {
  const warnings = captureWarnings();
  try {
    // spend -> responder is not a permitted exchange.
    const sender = createPeerBindingSender({ self: "spend", target: "responder", signingKey: brainSigningKey });
    let rejected = false;
    await sender
      .send({ RESPONDER: { deliverInteractionEdit: async () => undefined } } as never, replyEnvelope(), {
        name: "x.png",
        contentType: "image/png",
        data: new ArrayBuffer(4),
      }, { sub: "user-1" })
      .catch(() => (rejected = true));
    assert.equal(rejected, true);
    const denial = warnings.lines.find((line) => line.message === "peer_denied");
    assert.equal(denial?.reason, "exchange_not_authorized");
  } finally {
    warnings.restore();
  }
});
