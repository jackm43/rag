import { assert, test } from "vitest";

import { receiveResponderInteractionEdit } from "../../../../packages/boundaries/peer/binding.ts";
import { peerReceive } from "../../../../packages/boundaries/peer/queue.ts";
import { peerLinks } from "../../../../packages/boundaries/peer/links.ts";
import {
  decodeReplyJobEnvelope,
  encodeReplyJobEnvelope,
} from "../../../../packages/contracts/index.ts";
import type { PeerQueueMessage } from "../../../../packages/contracts/types.ts";
import { mintPeerToken, signedPeerMessage, SIGNING_KEY_JWKS } from "../../../helpers.ts";

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

test("a queue sender mints a token beside the envelope and the receiver verifies it", async () => {
  const sent: Array<{ body: PeerQueueMessage; options?: { delaySeconds?: number } }> = [];
  const queue = {
    send: async (body: PeerQueueMessage, options?: { delaySeconds?: number }) => {
      sent.push({ body, options });
    },
  } as never;
  const envelope = replyEnvelope();

  await peerLinks(brainEnv()).brainToResponderOutbox.send(queue, envelope, { sub: "user-1" });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body.envelope, envelope);
  assert.isString(sent[0].body.idToken);

  const decoded = await peerReceive(sent[0].body, decodeReplyJobEnvelope, {
    self: "responder",
    expectedIssuers: ["brain"],
  });
  assert.deepEqual(decoded, { kind: "reply.channel_message", channelId: CHANNEL_ID, content: "hello" });
});

test("peerReceive denies a message with no identity token", async () => {
  const warnings = captureWarnings();
  try {
    const denied = await peerReceive({ envelope: replyEnvelope() }, decodeReplyJobEnvelope, {
      self: "responder",
      expectedIssuers: ["brain"],
    });
    assert.equal(denied, null);
    const denial = warnings.lines.find((line) => line.message === "peer_denied");
    assert.ok(denial);
    assert.equal(denial.trustZone, "peer-queue");
    assert.equal(denial.reason, "identity_missing");
  } finally {
    warnings.restore();
  }
});

test("peerReceive denies an invalid envelope even under a valid token", async () => {
  const warnings = captureWarnings();
  try {
    const garbage = new Uint8Array([1, 2, 3, 4, 5]);
    const message = { envelope: garbage, idToken: await mintPeerToken(garbage, { iss: "brain", aud: "responder" }) };
    const invalid = await peerReceive(message, decodeReplyJobEnvelope, {
      self: "responder",
      expectedIssuers: ["brain"],
    });
    assert.equal(invalid, null);
    const denial = warnings.lines.find((line) => line.message === "peer_denied");
    assert.ok(denial);
    assert.equal(denial.reason, "envelope_invalid");
  } finally {
    warnings.restore();
  }
});

test("peerReceive denies a token minted for a different envelope (replay)", async () => {
  const warnings = captureWarnings();
  try {
    const token = await mintPeerToken(replyEnvelope(), { iss: "brain", aud: "responder" });
    const forged: PeerQueueMessage = {
      envelope: encodeReplyJobEnvelope(
        { kind: "reply.channel_message", channelId: CHANNEL_ID, content: "different" },
        { source: "worker" },
      ),
      idToken: token,
    };
    const denied = await peerReceive(forged, decodeReplyJobEnvelope, {
      self: "responder",
      expectedIssuers: ["brain"],
    });
    assert.equal(denied, null);
    const denial = warnings.lines.find((line) => line.message === "peer_denied");
    assert.ok(denial);
    assert.equal(denial.reason, "identity_envelope_mismatch");
  } finally {
    warnings.restore();
  }
});

test("peerReceive denies a token addressed to another worker", async () => {
  const warnings = captureWarnings();
  try {
    const message = await signedPeerMessage(replyEnvelope(), { iss: "brain", aud: "spend" });
    const denied = await peerReceive(message, decodeReplyJobEnvelope, {
      self: "responder",
      expectedIssuers: ["brain"],
    });
    assert.equal(denied, null);
    const denial = warnings.lines.find((line) => line.message === "peer_denied");
    assert.ok(denial);
    assert.equal(denial.reason, "identity_aud_mismatch");
  } finally {
    warnings.restore();
  }
});

test("peerReceive runs the Cedar hook only after a valid token, with the verified issuer", async () => {
  const message = await signedPeerMessage(replyEnvelope(), { iss: "brain", aud: "responder" });
  const seen: string[] = [];
  const decoded = await peerReceive(message, decodeReplyJobEnvelope, {
    self: "responder",
    expectedIssuers: ["brain"],
    authorize: (hop) => {
      seen.push(hop.identity);
      return true;
    },
  });
  assert.ok(decoded);
  assert.deepEqual(seen, ["brain"]);
});

test("peer boundaries drop envelopes the authorize hook denies", async () => {
  const warnings = captureWarnings();
  try {
    const message = await signedPeerMessage(replyEnvelope(), { iss: "brain", aud: "responder" });
    const denied = await peerReceive(message, decodeReplyJobEnvelope, {
      self: "responder",
      expectedIssuers: ["brain"],
      authorize: () => false,
    });
    assert.equal(denied, null);
    const denial = warnings.lines.find((line) => line.message === "peer_denied");
    assert.ok(denial);
    assert.equal(denial.reason, "not_authorized");
  } finally {
    warnings.restore();
  }
});

test("binding hop verifies the token then re-validates the envelope kind", async () => {
  const envelope = encodeReplyJobEnvelope(
    {
      kind: "reply.interaction_edit",
      applicationId: APPLICATION_ID,
      interactionToken: "interaction-token",
      content: "hello",
    },
    { source: "worker" },
  );
  const job = await receiveResponderInteractionEdit(
    envelope,
    await mintPeerToken(envelope, { iss: "brain", aud: "responder" }),
    { expectedIssuers: ["brain"] },
  );
  assert.equal(job?.kind, "reply.interaction_edit");
  assert.equal(job?.applicationId, APPLICATION_ID);

  // A channel-message envelope verifies but is the wrong kind for this hop.
  const warnings = captureWarnings();
  try {
    const channel = replyEnvelope();
    const wrongKind = await receiveResponderInteractionEdit(
      channel,
      await mintPeerToken(channel, { iss: "brain", aud: "responder" }),
      { expectedIssuers: ["brain"] },
    );
    assert.equal(wrongKind, null);
    const denial = warnings.lines.find((line) => line.message === "peer_denied");
    assert.ok(denial);
    assert.equal(denial.trustZone, "peer-binding");
    assert.equal(denial.reason, "envelope_invalid");
  } finally {
    warnings.restore();
  }
});

test("a queue send without a signing key fails closed", async () => {
  const warnings = captureWarnings();
  try {
    let sent = false;
    const queue = {
      send: async () => {
        sent = true;
      },
    } as never;
    let rejected = false;
    // Env with no BRAIN_SIGNING_KEY: minting is impossible, so the send denies.
    await peerLinks({} as never)
      .brainToResponderOutbox.send(queue, replyEnvelope(), { sub: "user-1" })
      .catch(() => {
        rejected = true;
      });
    assert.equal(rejected, true);
    assert.equal(sent, false);
    const denial = warnings.lines.find((line) => line.message === "peer_denied");
    assert.ok(denial);
    assert.equal(denial.reason, "signing_key_unavailable");
  } finally {
    warnings.restore();
  }
});
