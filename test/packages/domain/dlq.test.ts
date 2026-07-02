import { assert, test } from "vitest";

import {
  processAiJobsDlqMessage,
  processOutboxDlqMessage,
  processSpendJobsDlqMessage,
} from "../../../packages/domain/dlq.ts";
import {
  encodeAiJobEnvelope,
  encodeAiSpendJobEnvelope,
  encodeReplyJobEnvelope,
} from "../../../packages/contracts/index.ts";

const CHANNEL_ID = "200000000000000001";

const captureErrorLogs = () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => {
    lines.push(String(line));
  };
  return { lines, restore: () => (console.error = original) };
};

const createDlqMessage = (body: unknown, attempts = 3) => {
  let acked = false;
  return {
    message: {
      id: "dlq-message-id",
      timestamp: new Date(),
      body,
      attempts,
      ack: () => {
        acked = true;
      },
      retry: () => {
        throw new Error("dead letters must be acked, not retried");
      },
    } as unknown as Message<unknown>,
    wasAcked: () => acked,
  };
};

test("ai-jobs DLQ handler logs the envelope kind without content and acks", () => {
  const secretPrompt = "the launch codes are 0000";
  const body = encodeAiJobEnvelope(
    {
      kind: "channel_reply",
      channelId: CHANNEL_ID,
      prompt: secretPrompt,
    },
    { source: "gateway" },
  );
  const { message, wasAcked } = createDlqMessage(body);
  const logs = captureErrorLogs();

  try {
    processAiJobsDlqMessage(message);
  } finally {
    logs.restore();
  }

  assert.isTrue(wasAcked());
  assert.equal(logs.lines.length, 1);
  const entry = JSON.parse(logs.lines[0]);
  assert.equal(entry.message, "dead_letter_message");
  assert.equal(entry.queue, "ai-jobs-dlq");
  assert.equal(entry.messageId, "dlq-message-id");
  assert.equal(entry.attempts, 3);
  assert.equal(entry.kind, "channel_reply");
  assert.notInclude(logs.lines[0], secretPrompt);
});

test("ai-jobs DLQ handler marks undecodable bodies and still acks", () => {
  const { message, wasAcked } = createDlqMessage(new Uint8Array([1, 2, 3]));
  const logs = captureErrorLogs();

  try {
    processAiJobsDlqMessage(message);
  } finally {
    logs.restore();
  }

  assert.isTrue(wasAcked());
  assert.equal(JSON.parse(logs.lines[0]).kind, "undecodable");
});

test("spend DLQ handler logs the spend kind and acks", () => {
  const body = encodeAiSpendJobEnvelope({ spendEventId: "aigreq:test-event" }, { source: "worker" });
  const { message, wasAcked } = createDlqMessage(body, 5);
  const logs = captureErrorLogs();

  try {
    processSpendJobsDlqMessage(message);
  } finally {
    logs.restore();
  }

  assert.isTrue(wasAcked());
  const entry = JSON.parse(logs.lines[0]);
  assert.equal(entry.queue, "ai-spend-jobs-dlq");
  assert.equal(entry.attempts, 5);
  assert.equal(entry.kind, "spend");
});

test("outbox DLQ handler logs the reply kind without content and acks", () => {
  const secretReply = "confidential model output";
  const body = encodeReplyJobEnvelope(
    { kind: "reply.channel_message", channelId: CHANNEL_ID, content: secretReply },
    { source: "worker" },
  );
  const { message, wasAcked } = createDlqMessage(body);
  const logs = captureErrorLogs();

  try {
    processOutboxDlqMessage(message);
  } finally {
    logs.restore();
  }

  assert.isTrue(wasAcked());
  const entry = JSON.parse(logs.lines[0]);
  assert.equal(entry.queue, "discord-outbox-dlq");
  assert.equal(entry.kind, "reply.channel_message");
  assert.notInclude(logs.lines[0], secretReply);
});
