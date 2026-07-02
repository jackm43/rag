import { assert, test } from "vitest";

import {
  receiveResponderInteractionEdit,
  sendResponderInteractionEdit,
} from "../../../../packages/boundaries/peer/binding.ts";
import { peerReceive, peerSend } from "../../../../packages/boundaries/peer/queue.ts";
import { decodeReplyJobEnvelope, encodeReplyJobEnvelope } from "../../../../packages/contracts/index.ts";

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

test("peerSend hands the envelope and options to the queue unchanged", async () => {
  const sent: Array<{ body: Uint8Array; options?: { delaySeconds?: number } }> = [];
  const queue = {
    send: async (body: Uint8Array, options?: { delaySeconds?: number }) => {
      sent.push({ body, options });
    },
  } as never;
  const envelope = replyEnvelope();

  await peerSend(queue, envelope, "brain");
  await peerSend(queue, envelope, "brain", { delaySeconds: 120 });

  assert.equal(sent.length, 2);
  assert.equal(sent[0].body, envelope);
  assert.equal(sent[0].options, undefined);
  assert.deepEqual(sent[1].options, { delaySeconds: 120 });
});

test("peerReceive decodes valid envelopes and logs denials with the boundary context shape", () => {
  const warnings = captureWarnings();
  try {
    const decoded = peerReceive(replyEnvelope(), decodeReplyJobEnvelope, "brain");
    assert.deepEqual(decoded, {
      kind: "reply.channel_message",
      channelId: CHANNEL_ID,
      content: "hello",
    });
    assert.equal(warnings.lines.length, 0);

    const invalid = peerReceive(new Uint8Array([1, 2, 3, 4, 5]), decodeReplyJobEnvelope, "brain");
    assert.equal(invalid, null);

    const denial = warnings.lines.find((line) => line.message === "peer_denied");
    assert.ok(denial);
    assert.equal(denial.identity, "brain");
    assert.equal(denial.trustZone, "peer-queue");
    assert.equal(denial.outcome, "denied");
    assert.equal(denial.reason, "envelope_invalid");
  } finally {
    warnings.restore();
  }
});

test("peer boundaries drop envelopes the authorize seam denies", async () => {
  const warnings = captureWarnings();
  try {
    const denied = peerReceive(replyEnvelope(), decodeReplyJobEnvelope, "brain", () => false);
    assert.equal(denied, null);

    const denial = warnings.lines.find((line) => line.message === "peer_denied");
    assert.ok(denial);
    assert.equal(denial.reason, "not_authorized");

    let sent = false;
    const queue = {
      send: async () => {
        sent = true;
      },
    } as never;
    let rejected = false;
    await peerSend(queue, replyEnvelope(), "brain", { authorize: () => false }).catch(() => {
      rejected = true;
    });
    assert.equal(rejected, true);
    assert.equal(sent, false);
  } finally {
    warnings.restore();
  }
});

test("binding hop re-validates envelopes on receive with the peer-binding context", () => {
  const warnings = captureWarnings();
  try {
    const job = receiveResponderInteractionEdit(
      encodeReplyJobEnvelope(
        {
          kind: "reply.interaction_edit",
          applicationId: APPLICATION_ID,
          interactionToken: "interaction-token",
          content: "hello",
        },
        { source: "worker" },
      ),
    );
    assert.equal(job?.kind, "reply.interaction_edit");
    assert.equal(job?.applicationId, APPLICATION_ID);

    // A channel-message envelope decodes but is the wrong kind for this hop.
    const wrongKind = receiveResponderInteractionEdit(replyEnvelope());
    assert.equal(wrongKind, null);

    const denial = warnings.lines.find((line) => line.message === "peer_denied");
    assert.ok(denial);
    assert.equal(denial.identity, "brain");
    assert.equal(denial.trustZone, "peer-binding");
    assert.equal(denial.outcome, "denied");
    assert.equal(denial.reason, "envelope_invalid");
  } finally {
    warnings.restore();
  }
});

test("binding hop send requires the RESPONDER binding and forwards envelope + attachment", async () => {
  const calls: Array<{ envelope: Uint8Array; attachment: { name: string } }> = [];
  const attachment = { name: "bicture.png", contentType: "image/png", data: new ArrayBuffer(4) };
  const envelope = replyEnvelope();

  let rejected = false;
  await sendResponderInteractionEdit({} as never, envelope, attachment).catch(() => {
    rejected = true;
  });
  assert.equal(rejected, true);

  const env = {
    RESPONDER: {
      deliverInteractionEdit: async (sentEnvelope: Uint8Array, sentAttachment: { name: string }) => {
        calls.push({ envelope: sentEnvelope, attachment: sentAttachment });
      },
    },
  } as never;
  await sendResponderInteractionEdit(env, envelope, attachment);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].envelope, envelope);
  assert.equal(calls[0].attachment.name, "bicture.png");
});
