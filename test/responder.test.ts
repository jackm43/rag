import { assert, test } from "vitest";

import responderWorker, { deliverInteractionEdit, finalizeAiReplyText } from "../src/responder-worker.ts";
import { encodeReplyJobEnvelope } from "../src/contracts/index.ts";
import { createEnv } from "./helpers.ts";

const CHANNEL_ID = "200000000000000001";
const APPLICATION_ID = "500000000000000001";

test("finalizeAiReplyText sanitizes mentions, truncates, and falls back on empty output", () => {
  assert.equal(
    finalizeAiReplyText("Hello <@123456789012345678> there 123456789012345678"),
    "Hello there",
  );
  assert.equal(finalizeAiReplyText("<@123456789012345678>"), "I could not generate a response.");
  assert.equal(finalizeAiReplyText("a".repeat(3000)).length, 1900);
});

test("responder posts sanitized channel messages with allowed_mentions locked down", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return new Response("{}", { status: 200 });
  };

  try {
    const env = createEnv("unused", { DISCORD_BOT_TOKEN: "bot-token" });
    let acked = false;

    await responderWorker.queue({
      messages: [
        {
          body: encodeReplyJobEnvelope(
            {
              kind: "reply.channel_message",
              channelId: CHANNEL_ID,
              content: "Ping <@123456789012345678> and @everyone",
            },
            { source: "worker" },
          ),
          ack: () => {
            acked = true;
          },
          retry: () => {
            throw new Error("message should not be retried");
          },
        },
      ],
    } as never, env);

    const postCall = fetchCalls.find(
      (call) => call.url === `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`,
    );
    assert.ok(postCall);
    assert.equal(
      (postCall.init?.headers as Record<string, string>).authorization,
      "Bot bot-token",
    );
    assert.deepEqual(JSON.parse(String(postCall.init?.body)), {
      content: "Ping and everyone",
      allowed_mentions: {
        parse: [],
      },
    });
    assert.equal(acked, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("responder edits interactions with text-only content through the outbox", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return new Response("{}", { status: 200 });
  };

  try {
    const env = createEnv("unused", { DISCORD_BOT_TOKEN: "bot-token" });
    let acked = false;

    await responderWorker.queue({
      messages: [
        {
          body: encodeReplyJobEnvelope(
            {
              kind: "reply.interaction_edit",
              applicationId: APPLICATION_ID,
              interactionToken: "interaction-token",
              content: `Generated song: https://example.com/song.mp3\nPrompt: ${"a".repeat(2100)}`,
            },
            { source: "worker" },
          ),
          ack: () => {
            acked = true;
          },
          retry: () => {
            throw new Error("message should not be retried");
          },
        },
      ],
    } as never, env);

    const editCall = fetchCalls.find(
      (call) => call.url === `https://discord.com/api/v10/webhooks/${APPLICATION_ID}/interaction-token/messages/@original`,
    );
    assert.ok(editCall);
    assert.equal(editCall.init?.method, "PATCH");
    const body = JSON.parse(String(editCall.init?.body));
    // Interaction-edit content is command feedback, not model output: it keeps
    // its format (no speaker-line stripping) but is capped at the Discord hard
    // limit and locked down with allowed_mentions.
    assert.ok(body.content.startsWith("Generated song: https://example.com/song.mp3"));
    assert.equal(body.content.length, 2000);
    assert.deepEqual(body.allowed_mentions, { parse: [] });
    assert.equal(acked, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("responder delivers media interaction edits over the RPC path", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const imageBytes = new Uint8Array([255, 216, 255, 217]);
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return new Response("{}", { status: 200 });
  };

  try {
    const env = createEnv("unused", { DISCORD_BOT_TOKEN: "bot-token" });

    await deliverInteractionEdit(
      env,
      encodeReplyJobEnvelope(
        {
          kind: "reply.interaction_edit",
          applicationId: APPLICATION_ID,
          interactionToken: "interaction-token",
          content: "a tiny jpeg test image",
        },
        { source: "worker" },
      ),
      {
        name: "bicture.png",
        contentType: "image/png",
        data: imageBytes.slice().buffer,
      },
    );

    const editCall = fetchCalls.find(
      (call) => call.url === `https://discord.com/api/v10/webhooks/${APPLICATION_ID}/interaction-token/messages/@original`,
    );
    assert.ok(editCall);
    assert.equal(editCall.init?.method, "PATCH");
    assert.ok(editCall.init?.body instanceof FormData);

    const form = editCall.init.body as FormData;
    assert.deepEqual(JSON.parse(String(form.get("payload_json"))), {
      content: "a tiny jpeg test image",
      allowed_mentions: { parse: [] },
      attachments: [{ id: "0", filename: "bicture.png" }],
    });

    const file = form.get("files[0]");
    assert.ok(file instanceof File);
    assert.equal(file.name, "bicture.png");
    assert.equal(file.type, "image/png");
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), imageBytes);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("responder rejects RPC envelopes that are not interaction edits", async () => {
  const env = createEnv("unused", { DISCORD_BOT_TOKEN: "bot-token" });
  const rejects = async (run: () => Promise<unknown>) => {
    let rejected = false;
    await run().catch(() => {
      rejected = true;
    });
    assert.equal(rejected, true);
  };

  await rejects(() =>
    deliverInteractionEdit(
      env,
      encodeReplyJobEnvelope(
        { kind: "reply.channel_message", channelId: CHANNEL_ID, content: "hello" },
        { source: "worker" },
      ),
      { name: "bicture.png", contentType: "image/png", data: new ArrayBuffer(4) },
    ),
  );
  await rejects(() => deliverInteractionEdit(env, new Uint8Array([1, 2, 3, 4, 5]), null));
});

test("responder acknowledges malformed outbox messages without egress", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: string[] = [];
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    return new Response("{}", { status: 200 });
  };

  try {
    const env = createEnv("unused", { DISCORD_BOT_TOKEN: "bot-token" });
    let acked = false;

    await responderWorker.queue({
      messages: [
        {
          body: new Uint8Array([1, 2, 3, 4, 5]),
          ack: () => {
            acked = true;
          },
          retry: () => {
            throw new Error("message should not be retried");
          },
        },
      ],
    } as never, env);

    assert.deepEqual(fetchCalls, []);
    assert.equal(acked, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("responder retries channel posts on retryable Discord errors and acks terminal ones", async () => {
  const originalFetch = globalThis.fetch;
  let status = 500;
  globalThis.fetch = async () => new Response("{}", { status });

  try {
    const env = createEnv("unused", { DISCORD_BOT_TOKEN: "bot-token" });
    const body = encodeReplyJobEnvelope(
      { kind: "reply.channel_message", channelId: CHANNEL_ID, content: "hello" },
      { source: "worker" },
    );

    let retried = false;
    await responderWorker.queue({
      messages: [
        {
          body,
          ack: () => {
            throw new Error("message should not be acked");
          },
          retry: () => {
            retried = true;
          },
        },
      ],
    } as never, env);
    assert.equal(retried, true);

    status = 403;
    let acked = false;
    await responderWorker.queue({
      messages: [
        {
          body,
          ack: () => {
            acked = true;
          },
          retry: () => {
            throw new Error("message should not be retried");
          },
        },
      ],
    } as never, env);
    assert.equal(acked, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
