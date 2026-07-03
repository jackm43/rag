import { assert, test } from "vitest";

import responderWorker from "../../workers/services/responder/src/index.ts";
import {
  deliverInteractionEdit,
  finalizeAiReplyText,
  suppressUrlEmbeds,
} from "../../packages/domain/responder.ts";
import { appendSourceFallback } from "../../packages/ai/ask-mode.ts";
import { editOriginalInteractionResponse } from "../../packages/discord/index.ts";
import { encodeReplyJobEnvelope } from "../../packages/contracts/index.ts";
import { createEnv, mintServiceToken, signedServiceMessage } from "../helpers.ts";

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

test("suppressUrlEmbeds wraps bare URLs in angle brackets so Discord renders no preview", () => {
  assert.equal(
    suppressUrlEmbeds("Check https://evil.example.com/login for details"),
    "Check <https://evil.example.com/login> for details",
  );
  assert.equal(
    suppressUrlEmbeds("See https://example.com/a and http://example.com/b"),
    "See <https://example.com/a> and <http://example.com/b>",
  );
  assert.equal(suppressUrlEmbeds("no links here"), "no links here");
});

test("suppressUrlEmbeds keeps trailing punctuation outside the brackets", () => {
  assert.equal(suppressUrlEmbeds("Read https://example.com/docs."), "Read <https://example.com/docs>.");
  assert.equal(suppressUrlEmbeds("Really https://example.com/a?q=1!?"), "Really <https://example.com/a?q=1>!?");
});

test("suppressUrlEmbeds does not double-wrap already-wrapped URLs", () => {
  assert.equal(suppressUrlEmbeds("Already <https://example.com/ok> wrapped"), "Already <https://example.com/ok> wrapped");
});

test("suppressUrlEmbeds leaves URLs inside code spans and fenced blocks alone", () => {
  assert.equal(
    suppressUrlEmbeds("Run `curl https://example.com/api` locally"),
    "Run `curl https://example.com/api` locally",
  );
  assert.equal(
    suppressUrlEmbeds("```\nfetch(\"https://example.com/api\")\n```\nMore at https://example.com/docs"),
    "```\nfetch(\"https://example.com/api\")\n```\nMore at <https://example.com/docs>",
  );
});

test("finalizeAiReplyText suppresses embeds for URLs in model output", () => {
  assert.equal(
    finalizeAiReplyText("Reset your password here\nhttps://evil.example.com/reset now"),
    "Reset your password here\n<https://evil.example.com/reset> now",
  );
});

test("appendSourceFallback wraps web-search source URLs so they stay clickable without embeds", () => {
  assert.equal(
    appendSourceFallback("Latest figures say 42.", [
      { url: "https://example.com/a", title: "A" },
      { url: "https://example.com/b", title: "B" },
    ]),
    "Latest figures say 42.\n\nSources: <https://example.com/a> <https://example.com/b>",
  );
});

test("editOriginalInteractionResponse logs rejected edits without the token and returns the ok flag", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnLines: string[] = [];
  console.warn = (line: unknown) => {
    warnLines.push(String(line));
  };
  globalThis.fetch = async () => new Response("{}", { status: 404 });

  try {
    const env = createEnv("unused", { DISCORD_BOT_TOKEN: "bot-token" });

    const rejectedOk = await editOriginalInteractionResponse(env, APPLICATION_ID, "interaction-token", {
      content: "hello",
    });
    assert.isFalse(rejectedOk);
    const rejectedEntry = warnLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.message === "interaction_edit_rejected");
    assert.ok(rejectedEntry, "a rejected edit must be logged");
    assert.equal(rejectedEntry?.status, 404);
    assert.equal(rejectedEntry?.applicationId, APPLICATION_ID);
    assert.notInclude(JSON.stringify(rejectedEntry), "interaction-token");

    warnLines.length = 0;
    globalThis.fetch = async () => new Response("{}", { status: 200 });
    const acceptedOk = await editOriginalInteractionResponse(env, APPLICATION_ID, "interaction-token", {
      content: "hello",
    });
    assert.isTrue(acceptedOk);
    assert.notInclude(warnLines.join("\n"), "interaction_edit_rejected");
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
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
      queue: "discord-outbox",
      messages: [
        {
          body: await signedServiceMessage(
            encodeReplyJobEnvelope(
              {
                kind: "reply.channel_message",
                channelId: CHANNEL_ID,
                content: "Ping <@123456789012345678> and @everyone",
              },
              { source: "worker" },
            ),
            { iss: "workflows", aud: "responder" },
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
      queue: "discord-outbox",
      messages: [
        {
          body: await signedServiceMessage(
            encodeReplyJobEnvelope(
              {
                kind: "reply.interaction_edit",
                applicationId: APPLICATION_ID,
                interactionToken: "interaction-token",
                content: `Generated song: https://example.com/song.mp3\nPrompt: ${"a".repeat(2100)}`,
              },
              { source: "worker" },
            ),
            { iss: "workflows", aud: "responder" },
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

    const mediaEnvelope = encodeReplyJobEnvelope(
      {
        kind: "reply.interaction_edit",
        applicationId: APPLICATION_ID,
        interactionToken: "interaction-token",
        content: "a tiny jpeg test image",
      },
      { source: "worker" },
    );
    await deliverInteractionEdit(
      env,
      mediaEnvelope,
      await mintServiceToken(mediaEnvelope, { iss: "workflows", aud: "responder" }),
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

  const channelEnvelope = encodeReplyJobEnvelope(
    { kind: "reply.channel_message", channelId: CHANNEL_ID, content: "hello" },
    { source: "worker" },
  );
  await rejects(async () =>
    deliverInteractionEdit(
      env,
      channelEnvelope,
      await mintServiceToken(channelEnvelope, { iss: "workflows", aud: "responder" }),
      { name: "bicture.png", contentType: "image/png", data: new ArrayBuffer(4) },
    ),
  );
  // A garbage token fails verification, so the edit is denied before decoding.
  await rejects(() => deliverInteractionEdit(env, new Uint8Array([1, 2, 3, 4, 5]), "not-a-token", null));
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
      queue: "discord-outbox",
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
    const body = await signedServiceMessage(
      encodeReplyJobEnvelope(
        { kind: "reply.channel_message", channelId: CHANNEL_ID, content: "hello" },
        { source: "worker" },
      ),
      { iss: "workflows", aud: "responder" },
    );

    let retried = false;
    await responderWorker.queue({
      queue: "discord-outbox",
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
      queue: "discord-outbox",
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
