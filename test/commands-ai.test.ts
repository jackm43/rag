import { assert, test } from "vitest";
import nacl from "tweetnacl";

import worker from "../src/index.ts";
import { shouldUseAskWebSearch } from "../src/commands/ask.ts";
import { decodeAiJobEnvelope, encodeAiJobEnvelope } from "../src/contracts/index.ts";
import { createDbMock, createEnv, createSignedRequest } from "./helpers.ts";

const RAGJAM_APPLICATION_ID = "500000000000000001";
const RAGJAM_CHANNEL_ID = "500000000000000002";
const RAGJAM_USER_ID = "500000000000000003";

test("/ask interaction is deferred, creates a titled thread, and posts the answer", async () => {
  const keyPair = nacl.sign.keyPair();
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const aiResponses = ["Worker queue retries", "Queues retry failed jobs before the DLQ."];
  const insertedThreads: Array<{ sql: string; args: unknown[] }> = [];
  const waitUntilPromises: Promise<unknown>[] = [];

  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url).includes("gateway.ai.cloudflare.com")) {
      return Response.json({ response: aiResponses.shift() ?? "Queues retry failed jobs before the DLQ." });
    }
    if (String(url) === "https://discord.com/api/v10/channels/channel-id") {
      return Response.json({ id: "channel-id", type: 0, name: "general" });
    }
    if (String(url) === "https://discord.com/api/v10/channels/channel-id/threads") {
      return Response.json({ id: "thread-id", type: 11, parent_id: "channel-id", name: "Worker queue retries" });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const baseDb = createDbMock();
    const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
      DISCORD_BOT_TOKEN: "bot-token",
      CF_ACCOUNT_ID: "account-id",
      CF_AIG_TOKEN: "gateway-token",
      DB: {
        ...baseDb,
        prepare: (sql: string) => {
          const base = createDbMock().prepare(sql);
          return {
            ...base,
            bind: (...args: unknown[]) => ({
              ...base.bind(...args),
              run: async () => {
                if (sql.includes("INSERT INTO rag_ai_threads")) {
                  insertedThreads.push({ sql, args });
                }
                return base.bind(...args).run();
              },
            }),
          };
        },
      },
    });
    const request = createSignedRequest(
      {
        application_id: "application-id",
        channel_id: "channel-id",
        token: "interaction-token",
        type: 2,
        data: {
          name: "ask",
          options: [{ name: "prompt", value: "How do queue retries work?" }],
        },
        member: { nick: "Alice", user: { id: "1", username: "alice", global_name: "Alice" } },
      },
      keyPair.secretKey,
    );

    const response = await worker.fetch(request, env, {
      waitUntil: (promise: Promise<unknown>) => {
        waitUntilPromises.push(promise);
      },
    } as never);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { type: 5 });
    await Promise.all(waitUntilPromises);

    const threadCall = fetchCalls.find(
      (call) => call.url === "https://discord.com/api/v10/channels/channel-id/threads",
    );
    assert.ok(threadCall);
    assert.deepEqual(JSON.parse(String(threadCall.init?.body)), {
      name: "Worker queue retries",
      type: 11,
      auto_archive_duration: 1440,
    });

    const postCall = fetchCalls.find(
      (call) => call.url === "https://discord.com/api/v10/channels/thread-id/messages",
    );
    assert.ok(postCall);
    assert.deepEqual(JSON.parse(String(postCall.init?.body)), {
      content: "Queues retry failed jobs before the DLQ.",
      allowed_mentions: {
        parse: [],
      },
    });

    const editCall = fetchCalls.find(
      (call) => call.url === "https://discord.com/api/v10/webhooks/application-id/interaction-token/messages/@original",
    );
    assert.ok(editCall);
    assert.deepEqual(JSON.parse(String(editCall.init?.body)), {
      content: "Started <#thread-id>",
      allowed_mentions: {
        parse: [],
      },
    });
    assert.deepEqual(insertedThreads[0].args, [
      "thread-id",
      "channel-id",
      null,
      "1",
      "Alice",
      "How do queue retries work?",
      "Worker queue retries",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("/ask web search heuristic detects current research requests", () => {
  assert.equal(
    shouldUseAskWebSearch("can you get me information on the best GPUs across nvidia and AMD currently?"),
    true,
  );
  assert.equal(shouldUseAskWebSearch("How do queue retries work?"), false);
  assert.equal(shouldUseAskWebSearch("What are the latest GPU prices?"), true);
});

test("/bicture interaction is deferred and edits the original response with an image attachment", async () => {
  const keyPair = nacl.sign.keyPair();
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const waitUntilPromises: Promise<unknown>[] = [];
  const imageBytes = new Uint8Array([255, 216, 255, 217]);
  const imageBase64 = Buffer.from(imageBytes).toString("base64");
  const aiRuns: Array<{ model: string; input: unknown; options: unknown }> = [];

  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return new Response("{}", { status: 200 });
  };

  try {
    const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
      AI: {
        run: async (model: string, input: unknown, options: unknown) => {
          aiRuns.push({ model, input, options });
          return { result: { image: `data:image/png;base64,${imageBase64}` } };
        },
      },
    });
    const request = createSignedRequest(
      {
        application_id: "application-id",
        token: "interaction-token",
        type: 2,
        data: {
          name: "bicture",
          options: [{ name: "prompt", value: "a tiny jpeg test image" }],
        },
        user: { id: "1", username: "alice" },
      },
      keyPair.secretKey,
    );

    const response = await worker.fetch(request, env, {
      waitUntil: (promise: Promise<unknown>) => {
        waitUntilPromises.push(promise);
      },
    } as never);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { type: 5 });
    await Promise.all(waitUntilPromises);

    assert.equal(aiRuns.length, 1);
    assert.equal(aiRuns[0].model, "xai/grok-imagine-image");
    assert.deepEqual(aiRuns[0].input, {
      prompt: "a tiny jpeg test image",
      response_format: "b64_json",
      aspect_ratio: "auto",
      quality: "low",
      resolution: "1k",
    });
    const bictureOptions = aiRuns[0].options as { gateway: { id: string; metadata: Record<string, string> } };
    assert.equal(bictureOptions.gateway.id, "platy");
    assert.equal(bictureOptions.gateway.metadata.ragbot_kind, "bicture");
    assert.equal(bictureOptions.gateway.metadata.discord_user_id, "1");
    assert.match(bictureOptions.gateway.metadata.ragbot_request_id, /^aigreq:/);

    const editCall = fetchCalls.find(
      (call) => call.url === "https://discord.com/api/v10/webhooks/application-id/interaction-token/messages/@original",
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

test("/bicture without a prompt returns an immediate validation message", async () => {
  const keyPair = nacl.sign.keyPair();
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"));
  const request = createSignedRequest(
    {
      application_id: "application-id",
      token: "interaction-token",
      type: 2,
      data: {
        name: "bicture",
        options: [{ name: "prompt", value: "   " }],
      },
      user: { id: "1", username: "alice" },
    },
    keyPair.secretKey,
  );

  const response = await worker.fetch(request, env, {} as never);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    type: 4,
    data: { content: "An image prompt is required.", allowed_mentions: { parse: [] } },
  });
});

test("/bicture downloads url-returned images with a timeout signal and attaches them", async () => {
  const keyPair = nacl.sign.keyPair();
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const waitUntilPromises: Promise<unknown>[] = [];
  const imageBytes = new Uint8Array([255, 216, 255, 217]);

  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url) === "https://example.com/generated-image.png") {
      return new Response(imageBytes, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(imageBytes.byteLength),
        },
      });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
      AI: {
        run: async () => ({ result: { image: "https://example.com/generated-image.png" } }),
      },
    });
    const request = createSignedRequest(
      {
        application_id: "application-id",
        token: "interaction-token",
        type: 2,
        data: {
          name: "bicture",
          options: [{ name: "prompt", value: "a tiny png test image" }],
        },
        user: { id: "1", username: "alice" },
      },
      keyPair.secretKey,
    );

    const response = await worker.fetch(request, env, {
      waitUntil: (promise: Promise<unknown>) => {
        waitUntilPromises.push(promise);
      },
    } as never);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { type: 5 });
    await Promise.all(waitUntilPromises);

    const downloadCall = fetchCalls.find((call) => call.url === "https://example.com/generated-image.png");
    assert.ok(downloadCall);
    assert.ok(downloadCall.init?.signal instanceof AbortSignal);

    const editCall = fetchCalls.find(
      (call) => call.url === "https://discord.com/api/v10/webhooks/application-id/interaction-token/messages/@original",
    );
    assert.ok(editCall);
    assert.ok(editCall.init?.body instanceof FormData);

    const form = editCall.init.body as FormData;
    const file = form.get("files[0]");
    assert.ok(file instanceof File);
    assert.equal(file.name, "bicture.png");
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), imageBytes);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("/bicture replies with a failure message when the generated image download exceeds the size cap", async () => {
  const keyPair = nacl.sign.keyPair();
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const waitUntilPromises: Promise<unknown>[] = [];
  let servedOversizedContentLength = false;

  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url) === "https://example.com/generated-image.png") {
      servedOversizedContentLength = true;
      return new Response(new Uint8Array([255, 216, 255, 217]), {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(25 * 1024 * 1024 + 1),
        },
      });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
      AI: {
        run: async () => ({ result: { image: "https://example.com/generated-image.png" } }),
      },
    });
    const request = createSignedRequest(
      {
        application_id: "application-id",
        token: "interaction-token",
        type: 2,
        data: {
          name: "bicture",
          options: [{ name: "prompt", value: "an oversized image" }],
        },
        user: { id: "1", username: "alice" },
      },
      keyPair.secretKey,
    );

    const response = await worker.fetch(request, env, {
      waitUntil: (promise: Promise<unknown>) => {
        waitUntilPromises.push(promise);
      },
    } as never);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { type: 5 });
    await Promise.all(waitUntilPromises);

    assert.equal(servedOversizedContentLength, true);

    const editCall = fetchCalls.find(
      (call) => call.url === "https://discord.com/api/v10/webhooks/application-id/interaction-token/messages/@original",
    );
    assert.ok(editCall);
    assert.deepEqual(JSON.parse(String(editCall.init?.body)), {
      content: "Could not generate that image. Try a different prompt.",
      allowed_mentions: { parse: [] },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("/ragjam interaction is deferred and enqueues music generation", async () => {
  const keyPair = nacl.sign.keyPair();
  const enqueuedJobs: unknown[] = [];
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
    AI_JOBS: {
      send: async (job: unknown) => {
        enqueuedJobs.push(job);
      },
    },
  });
  const request = createSignedRequest(
    {
      application_id: RAGJAM_APPLICATION_ID,
      channel_id: RAGJAM_CHANNEL_ID,
      token: "interaction-token",
      type: 2,
      data: {
        name: "ragjam",
        options: [
          { name: "prompt", value: "A warm acoustic folk ballad with fingerpicked guitar and gentle vocals" },
          { name: "lyrics", value: "Walking down a dusty road\nWith the sunset painting gold" },
        ],
      },
      user: { id: RAGJAM_USER_ID, username: "alice" },
    },
    keyPair.secretKey,
  );

  const response = await worker.fetch(request, env, {} as never);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { type: 5 });
  assert.equal(enqueuedJobs.length, 1);
  assert.ok(enqueuedJobs[0] instanceof Uint8Array);
  assert.deepEqual(decodeAiJobEnvelope(enqueuedJobs[0]), {
    kind: "ragjam",
    applicationId: RAGJAM_APPLICATION_ID,
    interactionToken: "interaction-token",
    channelId: RAGJAM_CHANNEL_ID,
    requesterUserId: RAGJAM_USER_ID,
    requesterUsername: "alice",
    prompt: "A warm acoustic folk ballad with fingerpicked guitar and gentle vocals",
    lyrics: "Walking down a dusty road\nWith the sunset painting gold",
  });
});

test("queue handler edits /ragjam response with an audio attachment", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const audioBytes = new Uint8Array([73, 68, 51, 4]);
  const aiRuns: Array<{ model: string; input: unknown; options: unknown }> = [];
  let acked = false;

  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url) === "https://example.com/generated-song.mp3") {
      return new Response(audioBytes, {
        status: 200,
        headers: {
          "content-type": "audio/mpeg",
          "content-length": String(audioBytes.byteLength),
        },
      });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const env = createEnv("unused", {
      AI: {
        run: async (model: string, input: unknown, options: unknown) => {
          aiRuns.push({ model, input, options });
          return { result: { audio: "https://example.com/generated-song.mp3" } };
        },
      },
    });
    await worker.queue({
      messages: [
        {
          body: encodeAiJobEnvelope(
            {
              kind: "ragjam",
              applicationId: RAGJAM_APPLICATION_ID,
              interactionToken: "interaction-token",
              channelId: RAGJAM_CHANNEL_ID,
              requesterUserId: RAGJAM_USER_ID,
              requesterUsername: "alice",
              prompt: "A warm acoustic folk ballad with fingerpicked guitar and gentle vocals",
              lyrics: "Walking down a dusty road\nWith the sunset painting gold",
            },
            { source: "interactions" },
          ),
          ack: () => {
            acked = true;
          },
        },
      ],
    } as never, env);

    assert.equal(aiRuns.length, 1);
    assert.equal(aiRuns[0].model, "minimax/music-2.6");
    assert.deepEqual(aiRuns[0].input, {
      prompt: "A warm acoustic folk ballad with fingerpicked guitar and gentle vocals",
      is_instrumental: false,
      lyrics: "Walking down a dusty road\nWith the sunset painting gold",
      lyrics_optimizer: false,
    });
    const ragjamOptions = aiRuns[0].options as { gateway: { id: string; metadata: Record<string, string> } };
    assert.equal(ragjamOptions.gateway.id, "platy");
    assert.equal(ragjamOptions.gateway.metadata.ragbot_kind, "ragjam");
    assert.equal(ragjamOptions.gateway.metadata.discord_user_id, RAGJAM_USER_ID);
    assert.equal(ragjamOptions.gateway.metadata.discord_channel_id, RAGJAM_CHANNEL_ID);
    assert.match(ragjamOptions.gateway.metadata.ragbot_request_id, /^aigreq:/);

    const downloadCall = fetchCalls.find((call) => call.url === "https://example.com/generated-song.mp3");
    assert.ok(downloadCall);
    assert.ok(downloadCall.init?.signal instanceof AbortSignal);

    const editCall = fetchCalls.find(
      (call) => call.url === `https://discord.com/api/v10/webhooks/${RAGJAM_APPLICATION_ID}/interaction-token/messages/@original`,
    );
    assert.ok(editCall);
    assert.equal(editCall.init?.method, "PATCH");
    assert.ok(editCall.init?.body instanceof FormData);

    const form = editCall.init.body as FormData;
    assert.deepEqual(JSON.parse(String(form.get("payload_json"))), {
      content: "Prompt: A warm acoustic folk ballad with fingerpicked guitar and gentle vocals",
      allowed_mentions: { parse: [] },
      attachments: [{ id: "0", filename: "ragjam.mp3" }],
    });

    const file = form.get("files[0]");
    assert.ok(file instanceof File);
    assert.equal(file.name, "ragjam.mp3");
    assert.equal(file.type, "audio/mpeg");
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), audioBytes);
    assert.equal(acked, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("queue handler preserves long /ragjam prompt text up to the Discord message limit", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const audioBytes = new Uint8Array([73, 68, 51, 4]);
  const longPrompt = `A warm acoustic folk ballad ${"with fingerpicked guitar ".repeat(30)}`.slice(0, 900);

  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url) === "https://example.com/generated-song.mp3") {
      return new Response(audioBytes, {
        status: 200,
        headers: {
          "content-type": "audio/mpeg",
          "content-length": String(audioBytes.byteLength),
        },
      });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const env = createEnv("unused", {
      AI: {
        run: async () => ({ result: { audio: "https://example.com/generated-song.mp3" } }),
      },
    });
    await worker.queue({
      messages: [
        {
          body: encodeAiJobEnvelope(
            {
              kind: "ragjam",
              applicationId: RAGJAM_APPLICATION_ID,
              interactionToken: "interaction-token",
              prompt: longPrompt,
            },
            { source: "interactions" },
          ),
          ack: () => undefined,
        },
      ],
    } as never, env);

    const editCall = fetchCalls.find(
      (call) => call.url === `https://discord.com/api/v10/webhooks/${RAGJAM_APPLICATION_ID}/interaction-token/messages/@original`,
    );
    assert.ok(editCall);
    assert.ok(editCall.init?.body instanceof FormData);

    const form = editCall.init.body as FormData;
    assert.deepEqual(JSON.parse(String(form.get("payload_json"))).content, `Prompt: ${longPrompt}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("/ragjam without lyrics enqueues auto-generated lyrics job", async () => {
  const keyPair = nacl.sign.keyPair();
  const enqueuedJobs: unknown[] = [];
  const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
    AI_JOBS: {
      send: async (job: unknown) => {
        enqueuedJobs.push(job);
      },
    },
  });
  const request = createSignedRequest(
    {
      application_id: RAGJAM_APPLICATION_ID,
      channel_id: RAGJAM_CHANNEL_ID,
      token: "interaction-token",
      type: 2,
      data: {
        name: "ragjam",
        options: [{ name: "prompt", value: "A warm acoustic folk ballad" }],
      },
      user: { id: RAGJAM_USER_ID, username: "alice" },
    },
    keyPair.secretKey,
  );

  const response = await worker.fetch(request, env, {} as never);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { type: 5 });
  assert.equal(enqueuedJobs.length, 1);
  assert.deepEqual(decodeAiJobEnvelope(enqueuedJobs[0]), {
    kind: "ragjam",
    applicationId: RAGJAM_APPLICATION_ID,
    interactionToken: "interaction-token",
    channelId: RAGJAM_CHANNEL_ID,
    requesterUserId: RAGJAM_USER_ID,
    requesterUsername: "alice",
    prompt: "A warm acoustic folk ballad",
  });
});

test("queue handler lets /ragjam auto-generate lyrics when omitted", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const audioBytes = new Uint8Array([73, 68, 51, 4]);
  const aiRuns: Array<{ model: string; input: unknown; options: unknown }> = [];

  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url) === "https://example.com/generated-song.mp3") {
      return new Response(audioBytes, {
        status: 200,
        headers: {
          "content-type": "audio/mpeg",
          "content-length": String(audioBytes.byteLength),
        },
      });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const env = createEnv("unused", {
      AI: {
        run: async (model: string, input: unknown, options: unknown) => {
          aiRuns.push({ model, input, options });
          return { result: { audio: "https://example.com/generated-song.mp3" } };
        },
      },
    });
    await worker.queue({
      messages: [
        {
          body: encodeAiJobEnvelope(
            {
              kind: "ragjam",
              applicationId: RAGJAM_APPLICATION_ID,
              interactionToken: "interaction-token",
              channelId: RAGJAM_CHANNEL_ID,
              requesterUserId: RAGJAM_USER_ID,
              requesterUsername: "alice",
              prompt: "A warm acoustic folk ballad",
            },
            { source: "interactions" },
          ),
          ack: () => undefined,
        },
      ],
    } as never, env);

    assert.equal(aiRuns.length, 1);
    assert.deepEqual(aiRuns[0].input, {
      prompt: "A warm acoustic folk ballad",
      is_instrumental: false,
      lyrics_optimizer: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("/ask uses the web-search model for current research prompts", async () => {
  const keyPair = nacl.sign.keyPair();
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const insertedThreads: Array<{ sql: string; args: unknown[] }> = [];
  const waitUntilPromises: Promise<unknown>[] = [];
  let gatewayCalls = 0;

  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url).includes("gateway.ai.cloudflare.com")) {
      gatewayCalls += 1;
      if (gatewayCalls === 1) {
        return Response.json({ response: "Current GPU picks" });
      }
      return Response.json({
        model: "gpt-4o-search-preview-2025-03-11",
        choices: [
          {
            message: {
              content:
                "Based on current reviews, compare RTX 5090, RTX 5080, RX 9990 XTX, and RX 9980 XT by price, power, and workload.",
              annotations: [
                {
                  type: "url_citation",
                  url_citation: {
                    url: "https://example.com/gpu-roundup",
                    title: "GPU roundup",
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
      });
    }
    if (String(url) === "https://discord.com/api/v10/channels/channel-id") {
      return Response.json({ id: "channel-id", type: 0, name: "general" });
    }
    if (String(url) === "https://discord.com/api/v10/channels/channel-id/threads") {
      return Response.json({ id: "thread-id", type: 11, parent_id: "channel-id", name: "Current GPU picks" });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const baseDb = createDbMock();
    const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
      DISCORD_BOT_TOKEN: "bot-token",
      CF_ACCOUNT_ID: "account-id",
      CF_AIG_TOKEN: "gateway-token",
      DB: {
        ...baseDb,
        prepare: (sql: string) => {
          const base = createDbMock().prepare(sql);
          return {
            ...base,
            bind: (...args: unknown[]) => ({
              ...base.bind(...args),
              run: async () => {
                if (sql.includes("INSERT INTO rag_ai_threads")) {
                  insertedThreads.push({ sql, args });
                }
                return base.bind(...args).run();
              },
            }),
          };
        },
      },
    });
    const request = createSignedRequest(
      {
        application_id: "application-id",
        channel_id: "channel-id",
        token: "interaction-token",
        type: 2,
        data: {
          name: "ask",
          options: [
            {
              name: "prompt",
              value: "can you get me information on the best GPUs across nvidia and AMD currently?",
            },
          ],
        },
        member: { nick: "Alice", user: { id: "1", username: "alice", global_name: "Alice" } },
      },
      keyPair.secretKey,
    );

    const response = await worker.fetch(request, env, {
      waitUntil: (promise: Promise<unknown>) => {
        waitUntilPromises.push(promise);
      },
    } as never);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { type: 5 });
    await Promise.all(waitUntilPromises);

    const webSearchCall = fetchCalls.filter((call) => call.url.includes("gateway.ai.cloudflare.com"))[1];
    assert.ok(webSearchCall);
    assert.equal(
      webSearchCall.url,
      "https://gateway.ai.cloudflare.com/v1/account-id/platy/compat/chat/completions",
    );
    assert.equal(
      (webSearchCall.init?.headers as Record<string, string>)["cf-aig-authorization"],
      "Bearer gateway-token",
    );
    const askMetadata = JSON.parse((webSearchCall.init?.headers as Record<string, string>)["cf-aig-metadata"]);
    assert.equal(askMetadata.ragbot_kind, "ask");
    assert.equal(askMetadata.discord_user_id, "1");
    assert.equal(askMetadata.discord_channel_id, "channel-id");
    assert.match(askMetadata.ragbot_request_id, /^aigreq:/);
    const webSearchBody = JSON.parse(String(webSearchCall.init?.body));
    assert.equal(webSearchBody.model, "openai/gpt-4o-search-preview");
    assert.match(webSearchBody.messages[0].content, /careful web research assistant/);
    assert.match(webSearchBody.messages[1].content, /best GPUs across nvidia and AMD currently/);
    assert.equal(webSearchBody.max_tokens, 1200);
    assert.deepEqual(webSearchBody.web_search_options, { search_context_size: "medium" });

    const postCall = fetchCalls.find(
      (call) => call.url === "https://discord.com/api/v10/channels/thread-id/messages",
    );
    assert.ok(postCall);
    assert.deepEqual(JSON.parse(String(postCall.init?.body)), {
      content:
        "Based on current reviews, compare RTX 5090, RTX 5080, RX 9990 XTX, and RX 9980 XT by price, power, and workload.\n\nSources: https://example.com/gpu-roundup",
      allowed_mentions: {
        parse: [],
      },
    });
    assert.deepEqual(insertedThreads[0].args, [
      "thread-id",
      "channel-id",
      null,
      "1",
      "Alice",
      "can you get me information on the best GPUs across nvidia and AMD currently?",
      "Current GPU picks",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("/ask reports AI response failures after creating the thread", async () => {
  const keyPair = nacl.sign.keyPair();
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const waitUntilPromises: Promise<unknown>[] = [];
  let gatewayCalls = 0;

  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url).includes("gateway.ai.cloudflare.com")) {
      gatewayCalls += 1;
      if (gatewayCalls === 2) {
        return Response.json({ error: { message: "web search model unavailable" } }, { status: 500 });
      }
      return Response.json({ response: "Current GPU picks" });
    }
    if (String(url) === "https://discord.com/api/v10/channels/channel-id") {
      return Response.json({ id: "channel-id", type: 0, name: "general" });
    }
    if (String(url) === "https://discord.com/api/v10/channels/channel-id/threads") {
      return Response.json({ id: "thread-id", type: 11, parent_id: "channel-id", name: "Current GPU picks" });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
      DISCORD_BOT_TOKEN: "bot-token",
      CF_ACCOUNT_ID: "account-id",
      CF_AIG_TOKEN: "gateway-token",
      DB: createDbMock(),
    });
    const request = createSignedRequest(
      {
        application_id: "application-id",
        channel_id: "channel-id",
        token: "interaction-token",
        type: 2,
        data: {
          name: "ask",
          options: [{ name: "prompt", value: "What are the latest GPU prices?" }],
        },
        member: { nick: "Alice", user: { id: "1", username: "alice", global_name: "Alice" } },
      },
      keyPair.secretKey,
    );

    const response = await worker.fetch(request, env, {
      waitUntil: (promise: Promise<unknown>) => {
        waitUntilPromises.push(promise);
      },
    } as never);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { type: 5 });
    await Promise.all(waitUntilPromises);

    const threadMessage = fetchCalls.find(
      (call) => call.url === "https://discord.com/api/v10/channels/thread-id/messages",
    );
    assert.ok(threadMessage);
    assert.deepEqual(JSON.parse(String(threadMessage.init?.body)), {
      content: "I started this thread, but the AI response failed. Try again in a moment.",
      allowed_mentions: {
        parse: [],
      },
    });

    const editCall = fetchCalls.find(
      (call) => call.url === "https://discord.com/api/v10/webhooks/application-id/interaction-token/messages/@original",
    );
    assert.ok(editCall);
    assert.deepEqual(JSON.parse(String(editCall.init?.body)), {
      content: "Started <#thread-id>, but the AI response failed.",
      allowed_mentions: {
        parse: [],
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
