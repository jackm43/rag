import { assert, test } from "vitest";
import nacl from "tweetnacl";

import worker from "../../workers/applications/gateway/api/middleware_client/src/index.ts";
import workflowsWorker from "../../workers/services/workflows/src/index.ts";
import { shouldUseAskWebSearch } from "../../packages/domain/commands/ask.ts";
import { decodeAiJobEnvelope, decodeReplyJobEnvelope } from "../../packages/contracts/index.ts";
import { createDbMock, createEnv, createSignedRequest, gatewayAiJob, sentEnvelope } from "../helpers.ts";

// Outbound HTTP bodies now travel through the egress hop as raw bytes, so a
// captured init.body is an ArrayBuffer rather than the original string. The
// bytes are byte-identical to before; decode them to assert on content.
const bodyText = (init: RequestInit | undefined): string => {
  const body = init?.body;
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(body);
  }
  return String(body);
};

const RAGJAM_APPLICATION_ID = "500000000000000001";
const RAGJAM_CHANNEL_ID = "500000000000000002";
const RAGJAM_USER_ID = "500000000000000003";
const BICTURE_APPLICATION_ID = "700000000000000001";
const BICTURE_CHANNEL_ID = "700000000000000002";
const BICTURE_USER_ID = "700000000000000003";
const ASK_CHANNEL_ID = "600000000000000001";
const ASK_THREAD_ID = "600000000000000002";
const ASK_USER_ID = "600000000000000003";

test("/ask replies with the thread link immediately and answers via the AI jobs queue", async () => {
  const keyPair = nacl.sign.keyPair();
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const enqueuedJobs: unknown[] = [];
  const outboxJobs: unknown[] = [];
  const insertedThreads: Array<{ sql: string; args: unknown[] }> = [];
  const insertedInteractions: Array<{ sql: string; args: unknown[] }> = [];
  const waitUntilPromises: Promise<unknown>[] = [];

  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url).includes("gateway.ai.cloudflare.com")) {
      return Response.json({ response: "Queues retry failed jobs before the DLQ." });
    }
    if (String(url) === `https://discord.com/api/v10/channels/${ASK_CHANNEL_ID}`) {
      return Response.json({ id: ASK_CHANNEL_ID, type: 0, name: "general" });
    }
    if (String(url) === `https://discord.com/api/v10/channels/${ASK_CHANNEL_ID}/threads`) {
      return Response.json({ id: ASK_THREAD_ID, type: 11, parent_id: ASK_CHANNEL_ID, name: "How do queue retries work" });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const baseDb = createDbMock();
    const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
      DISCORD_BOT_TOKEN: "bot-token",
      CF_ACCOUNT_ID: "account-id",
      CF_AIG_TOKEN: "gateway-token",
      AI_JOBS: {
        send: async (body: unknown) => {
          enqueuedJobs.push(body);
        },
      },
      DISCORD_OUTBOX: {
        send: async (body: unknown) => {
          outboxJobs.push(body);
        },
      },
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
                if (sql.includes("INSERT INTO rag_ai_interactions")) {
                  insertedInteractions.push({ sql, args });
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
        channel_id: ASK_CHANNEL_ID,
        token: "interaction-token",
        type: 2,
        data: {
          name: "ask",
          options: [{ name: "prompt", value: "How do queue retries work?" }],
        },
        member: { nick: "Alice", user: { id: ASK_USER_ID, username: "alice", global_name: "Alice" } },
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

    // No model call happens in the interaction path; the title comes from the prompt.
    assert.equal(fetchCalls.some((call) => call.url.includes("gateway.ai.cloudflare.com")), false);

    const threadCall = fetchCalls.find(
      (call) => call.url === `https://discord.com/api/v10/channels/${ASK_CHANNEL_ID}/threads`,
    );
    assert.ok(threadCall);
    assert.deepEqual(JSON.parse(bodyText(threadCall.init)), {
      name: "How do queue retries work",
      type: 11,
      auto_archive_duration: 1440,
    });

    const editCall = fetchCalls.find(
      (call) => call.url === "https://discord.com/api/v10/webhooks/application-id/interaction-token/messages/@original",
    );
    assert.ok(editCall);
    assert.deepEqual(JSON.parse(bodyText(editCall.init)), {
      content: `Started <#${ASK_THREAD_ID}>`,
      allowed_mentions: {
        parse: [],
      },
    });
    assert.deepEqual(insertedThreads[0].args, [
      ASK_THREAD_ID,
      ASK_CHANNEL_ID,
      null,
      ASK_USER_ID,
      "Alice",
      "How do queue retries work?",
      "How do queue retries work",
    ]);

    assert.equal(enqueuedJobs.length, 1);
    assert.ok(sentEnvelope(enqueuedJobs[0]) instanceof Uint8Array);
    assert.deepEqual(decodeAiJobEnvelope(sentEnvelope(enqueuedJobs[0])), {
      kind: "ask",
      channelId: ASK_THREAD_ID,
      requesterUserId: ASK_USER_ID,
      requesterUsername: "Alice",
      prompt: "How do queue retries work?",
    });

    // The queue consumer posts the answer into the thread.
    let acked = false;
    await workflowsWorker.queue({
      queue: "ai-jobs",
      messages: [
        {
          body: enqueuedJobs[0],
          ack: () => {
            acked = true;
          },
        },
      ],
    } as never, env);

    const gatewayCalls = fetchCalls.filter((call) => call.url.includes("gateway.ai.cloudflare.com"));
    assert.equal(gatewayCalls.length, 1);
    const gatewayBody = JSON.parse(bodyText(gatewayCalls[0].init)) as { messages: Array<{ role: string; content: string }> };
    assert.match(gatewayBody.messages[0].content, /This is a \/ask thread/);
    assert.deepEqual(gatewayBody.messages.slice(1), [
      { role: "user", content: "Alice: How do queue retries work?" },
    ]);

    // The workflows worker posts nothing to Discord itself; the answer goes through the outbox.
    assert.equal(
      fetchCalls.find((call) => call.url === `https://discord.com/api/v10/channels/${ASK_THREAD_ID}/messages`),
      undefined,
    );
    assert.equal(outboxJobs.length, 1);
    assert.deepEqual(decodeReplyJobEnvelope(sentEnvelope(outboxJobs[0])), {
      kind: "reply.channel_message",
      channelId: ASK_THREAD_ID,
      content: "Queues retry failed jobs before the DLQ.",
    });
    assert.equal(acked, true);
    assert.equal(insertedInteractions.length, 1);
    assert.equal(insertedInteractions[0].args[0], "ask");
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

test("/bicture interaction is deferred and enqueues image generation", async () => {
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
      application_id: BICTURE_APPLICATION_ID,
      channel_id: BICTURE_CHANNEL_ID,
      token: "interaction-token",
      type: 2,
      data: {
        name: "bicture",
        options: [{ name: "prompt", value: "a tiny jpeg test image" }],
      },
      user: { id: BICTURE_USER_ID, username: "alice" },
    },
    keyPair.secretKey,
  );

  const response = await worker.fetch(request, env, { waitUntil: () => undefined } as never);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { type: 5 });
  assert.equal(enqueuedJobs.length, 1);
  assert.ok(sentEnvelope(enqueuedJobs[0]) instanceof Uint8Array);
  assert.deepEqual(decodeAiJobEnvelope(sentEnvelope(enqueuedJobs[0])), {
    kind: "bicture",
    applicationId: BICTURE_APPLICATION_ID,
    interactionToken: "interaction-token",
    channelId: BICTURE_CHANNEL_ID,
    requesterUserId: BICTURE_USER_ID,
    requesterUsername: "alice",
    prompt: "a tiny jpeg test image",
  });
});

test("queue handler delivers the /bicture image through the responder RPC binding", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const imageBytes = new Uint8Array([255, 216, 255, 217]);
  const imageBase64 = Buffer.from(imageBytes).toString("base64");
  const aiRuns: Array<{ model: string; input: unknown; options: unknown }> = [];
  const rpcCalls: Array<{ envelope: Uint8Array; attachment: { name: string; contentType: string; data: ArrayBuffer } }> = [];
  let acked = false;

  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return new Response("{}", { status: 200 });
  };

  try {
    const env = createEnv("unused", {
      AI: {
        run: async (model: string, input: unknown, options: unknown) => {
          aiRuns.push({ model, input, options });
          return { result: { image: `data:image/png;base64,${imageBase64}` } };
        },
      },
      RESPONDER: {
        deliverInteractionEdit: async (envelope: Uint8Array, attachment: { name: string; contentType: string; data: ArrayBuffer }) => {
          rpcCalls.push({ envelope, attachment });
        },
      },
    });
    await workflowsWorker.queue({
      queue: "ai-jobs",
      messages: [
        {
          body: await gatewayAiJob(
            {
              kind: "bicture",
              applicationId: BICTURE_APPLICATION_ID,
              interactionToken: "interaction-token",
              channelId: BICTURE_CHANNEL_ID,
              requesterUserId: BICTURE_USER_ID,
              requesterUsername: "alice",
              prompt: "a tiny jpeg test image",
            },
            { source: "interactions" },
            env,
          ),
          ack: () => {
            acked = true;
          },
        },
      ],
    } as never, env);

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
    assert.equal(bictureOptions.gateway.metadata.discord_user_id, BICTURE_USER_ID);
    assert.equal(bictureOptions.gateway.metadata.discord_channel_id, BICTURE_CHANNEL_ID);
    assert.match(bictureOptions.gateway.metadata.ragbot_request_id, /^aigreq:/);

    // No direct Discord egress from the workflows worker; the media edit goes over RPC.
    assert.equal(fetchCalls.find((call) => call.url.includes("discord.com")), undefined);
    assert.equal(rpcCalls.length, 1);
    assert.deepEqual(decodeReplyJobEnvelope(sentEnvelope(rpcCalls[0].envelope)), {
      kind: "reply.interaction_edit",
      applicationId: BICTURE_APPLICATION_ID,
      interactionToken: "interaction-token",
      content: "a tiny jpeg test image",
    });
    assert.equal(rpcCalls[0].attachment.name, "bicture.png");
    assert.equal(rpcCalls[0].attachment.contentType, "image/png");
    assert.deepEqual(new Uint8Array(rpcCalls[0].attachment.data), imageBytes);
    assert.equal(acked, true);
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

  const response = await worker.fetch(request, env, { waitUntil: () => undefined } as never);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    type: 4,
    data: { content: "An image prompt is required.", allowed_mentions: { parse: [] } },
  });
});

test("queue handler downloads url-returned /bicture images with a timeout signal and attaches them", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
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
    const rpcCalls: Array<{ envelope: Uint8Array; attachment: { name: string; contentType: string; data: ArrayBuffer } }> = [];
    const env = createEnv("unused", {
      AI: {
        run: async () => ({ result: { image: "https://example.com/generated-image.png" } }),
      },
      RESPONDER: {
        deliverInteractionEdit: async (envelope: Uint8Array, attachment: { name: string; contentType: string; data: ArrayBuffer }) => {
          rpcCalls.push({ envelope, attachment });
        },
      },
    });
    await workflowsWorker.queue({
      queue: "ai-jobs",
      messages: [
        {
          body: await gatewayAiJob(
            {
              kind: "bicture",
              applicationId: BICTURE_APPLICATION_ID,
              interactionToken: "interaction-token",
              requesterUserId: BICTURE_USER_ID,
              requesterUsername: "alice",
              prompt: "a tiny png test image",
            },
            { source: "interactions" },
            env,
          ),
          ack: () => undefined,
        },
      ],
    } as never, env);

    const downloadCall = fetchCalls.find((call) => call.url === "https://example.com/generated-image.png");
    assert.ok(downloadCall);
    assert.ok(downloadCall.init?.signal instanceof AbortSignal);

    assert.equal(rpcCalls.length, 1);
    assert.deepEqual(decodeReplyJobEnvelope(sentEnvelope(rpcCalls[0].envelope)), {
      kind: "reply.interaction_edit",
      applicationId: BICTURE_APPLICATION_ID,
      interactionToken: "interaction-token",
      content: "a tiny png test image",
    });
    assert.equal(rpcCalls[0].attachment.name, "bicture.png");
    assert.deepEqual(new Uint8Array(rpcCalls[0].attachment.data), imageBytes);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("queue handler edits /bicture response with a failure message when the image download exceeds the size cap", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  let servedOversizedContentLength = false;
  let acked = false;

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
    const outboxJobs: unknown[] = [];
    const env = createEnv("unused", {
      AI: {
        run: async () => ({ result: { image: "https://example.com/generated-image.png" } }),
      },
      DISCORD_OUTBOX: {
        send: async (body: unknown) => {
          outboxJobs.push(body);
        },
      },
    });
    await workflowsWorker.queue({
      queue: "ai-jobs",
      messages: [
        {
          body: await gatewayAiJob(
            {
              kind: "bicture",
              applicationId: BICTURE_APPLICATION_ID,
              interactionToken: "interaction-token",
              requesterUserId: BICTURE_USER_ID,
              requesterUsername: "alice",
              prompt: "an oversized image",
            },
            { source: "interactions" },
            env,
          ),
          ack: () => {
            acked = true;
          },
        },
      ],
    } as never, env);

    assert.equal(servedOversizedContentLength, true);

    // The failure notice is text-only, so it travels through the outbox queue.
    assert.equal(outboxJobs.length, 1);
    assert.deepEqual(decodeReplyJobEnvelope(sentEnvelope(outboxJobs[0])), {
      kind: "reply.interaction_edit",
      applicationId: BICTURE_APPLICATION_ID,
      interactionToken: "interaction-token",
      content: "Could not generate that image. Try a different prompt.",
    });
    assert.equal(acked, true);
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

  const response = await worker.fetch(request, env, { waitUntil: () => undefined } as never);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { type: 5 });
  assert.equal(enqueuedJobs.length, 1);
  assert.ok(sentEnvelope(enqueuedJobs[0]) instanceof Uint8Array);
  assert.deepEqual(decodeAiJobEnvelope(sentEnvelope(enqueuedJobs[0])), {
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

test("queue handler delivers the /ragjam audio through the responder RPC binding", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const audioBytes = new Uint8Array([73, 68, 51, 4]);
  const aiRuns: Array<{ model: string; input: unknown; options: unknown }> = [];
  const rpcCalls: Array<{ envelope: Uint8Array; attachment: { name: string; contentType: string; data: ArrayBuffer } }> = [];
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
      RESPONDER: {
        deliverInteractionEdit: async (envelope: Uint8Array, attachment: { name: string; contentType: string; data: ArrayBuffer }) => {
          rpcCalls.push({ envelope, attachment });
        },
      },
    });
    await workflowsWorker.queue({
      queue: "ai-jobs",
      messages: [
        {
          body: await gatewayAiJob(
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
            env,
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

    // No direct Discord egress from the workflows worker; the media edit goes over RPC.
    assert.equal(fetchCalls.find((call) => call.url.includes("discord.com")), undefined);
    assert.equal(rpcCalls.length, 1);
    assert.deepEqual(decodeReplyJobEnvelope(sentEnvelope(rpcCalls[0].envelope)), {
      kind: "reply.interaction_edit",
      applicationId: RAGJAM_APPLICATION_ID,
      interactionToken: "interaction-token",
      content: "Prompt: A warm acoustic folk ballad with fingerpicked guitar and gentle vocals",
    });
    assert.equal(rpcCalls[0].attachment.name, "ragjam.mp3");
    assert.equal(rpcCalls[0].attachment.contentType, "audio/mpeg");
    assert.deepEqual(new Uint8Array(rpcCalls[0].attachment.data), audioBytes);
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
    const rpcCalls: Array<{ envelope: Uint8Array; attachment: { name: string; contentType: string; data: ArrayBuffer } }> = [];
    const env = createEnv("unused", {
      AI: {
        run: async () => ({ result: { audio: "https://example.com/generated-song.mp3" } }),
      },
      RESPONDER: {
        deliverInteractionEdit: async (envelope: Uint8Array, attachment: { name: string; contentType: string; data: ArrayBuffer }) => {
          rpcCalls.push({ envelope, attachment });
        },
      },
    });
    await workflowsWorker.queue({
      queue: "ai-jobs",
      messages: [
        {
          body: await gatewayAiJob(
            {
              kind: "ragjam",
              applicationId: RAGJAM_APPLICATION_ID,
              interactionToken: "interaction-token",
              prompt: longPrompt,
            },
            { source: "interactions" },
            env,
          ),
          ack: () => undefined,
        },
      ],
    } as never, env);

    assert.equal(rpcCalls.length, 1);
    assert.equal(decodeReplyJobEnvelope(sentEnvelope(rpcCalls[0].envelope))?.content, `Prompt: ${longPrompt}`);
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

  const response = await worker.fetch(request, env, { waitUntil: () => undefined } as never);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { type: 5 });
  assert.equal(enqueuedJobs.length, 1);
  assert.deepEqual(decodeAiJobEnvelope(sentEnvelope(enqueuedJobs[0])), {
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
      RESPONDER: {
        deliverInteractionEdit: async () => undefined,
      },
    });
    await workflowsWorker.queue({
      queue: "ai-jobs",
      messages: [
        {
          body: await gatewayAiJob(
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
            env,
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
  const enqueuedJobs: unknown[] = [];
  const insertedThreads: Array<{ sql: string; args: unknown[] }> = [];
  const waitUntilPromises: Promise<unknown>[] = [];

  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url).includes("gateway.ai.cloudflare.com")) {
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
    if (String(url) === `https://discord.com/api/v10/channels/${ASK_CHANNEL_ID}`) {
      return Response.json({ id: ASK_CHANNEL_ID, type: 0, name: "general" });
    }
    if (String(url) === `https://discord.com/api/v10/channels/${ASK_CHANNEL_ID}/threads`) {
      return Response.json({ id: ASK_THREAD_ID, type: 11, parent_id: ASK_CHANNEL_ID, name: "GPU picks" });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const baseDb = createDbMock();
    const outboxJobs: unknown[] = [];
    const env = createEnv(Buffer.from(keyPair.publicKey).toString("hex"), {
      DISCORD_BOT_TOKEN: "bot-token",
      CF_ACCOUNT_ID: "account-id",
      CF_AIG_TOKEN: "gateway-token",
      AI_JOBS: {
        send: async (body: unknown) => {
          enqueuedJobs.push(body);
        },
      },
      DISCORD_OUTBOX: {
        send: async (body: unknown) => {
          outboxJobs.push(body);
        },
      },
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
        channel_id: ASK_CHANNEL_ID,
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
        member: { nick: "Alice", user: { id: ASK_USER_ID, username: "alice", global_name: "Alice" } },
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

    assert.deepEqual(insertedThreads[0].args, [
      ASK_THREAD_ID,
      ASK_CHANNEL_ID,
      null,
      ASK_USER_ID,
      "Alice",
      "can you get me information on the best GPUs across nvidia and AMD currently?",
      "can you get me information on the best GPUs across nvidia and AMD currently",
    ]);
    assert.equal(enqueuedJobs.length, 1);

    await workflowsWorker.queue({
      queue: "ai-jobs",
      messages: [{ body: enqueuedJobs[0], ack: () => undefined }],
    } as never, env);

    const webSearchCall = fetchCalls.find((call) => call.url.includes("gateway.ai.cloudflare.com"));
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
    assert.equal(askMetadata.discord_user_id, ASK_USER_ID);
    assert.equal(askMetadata.discord_channel_id, ASK_THREAD_ID);
    assert.match(askMetadata.ragbot_request_id, /^aigreq:/);
    const webSearchBody = JSON.parse(bodyText(webSearchCall.init));
    assert.equal(webSearchBody.model, "openai/gpt-4o-search-preview");
    assert.match(webSearchBody.messages[0].content, /careful web research assistant/);
    assert.match(webSearchBody.messages[1].content, /best GPUs across nvidia and AMD currently/);
    assert.equal(webSearchBody.max_tokens, 1200);
    assert.deepEqual(webSearchBody.web_search_options, { search_context_size: "medium" });

    assert.equal(outboxJobs.length, 1);
    assert.deepEqual(decodeReplyJobEnvelope(sentEnvelope(outboxJobs[0])), {
      kind: "reply.channel_message",
      channelId: ASK_THREAD_ID,
      content:
        "Based on current reviews, compare RTX 5090, RTX 5080, RX 9990 XTX, and RX 9980 XT by price, power, and workload.\n\nSources: <https://example.com/gpu-roundup>",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("queue handler posts a failure notice into the thread when the /ask answer fails", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url).includes("gateway.ai.cloudflare.com")) {
      return Response.json({ error: { message: "web search model unavailable" } }, { status: 500 });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const outboxJobs: unknown[] = [];
    const env = createEnv("unused", {
      DISCORD_BOT_TOKEN: "bot-token",
      CF_ACCOUNT_ID: "account-id",
      CF_AIG_TOKEN: "gateway-token",
      DB: createDbMock(),
      DISCORD_OUTBOX: {
        send: async (body: unknown) => {
          outboxJobs.push(body);
        },
      },
    });
    let acked = false;

    await workflowsWorker.queue({
      queue: "ai-jobs",
      messages: [
        {
          body: await gatewayAiJob(
            {
              kind: "ask",
              channelId: ASK_THREAD_ID,
              requesterUserId: ASK_USER_ID,
              requesterUsername: "Alice",
              prompt: "What are the latest GPU prices?",
            },
            { source: "interactions" },
            env,
          ),
          ack: () => {
            acked = true;
          },
        },
      ],
    } as never, env);

    assert.equal(outboxJobs.length, 1);
    assert.deepEqual(decodeReplyJobEnvelope(sentEnvelope(outboxJobs[0])), {
      kind: "reply.channel_message",
      channelId: ASK_THREAD_ID,
      content: "I started this thread, but the AI response failed. Try again in a moment.",
    });
    assert.equal(acked, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
