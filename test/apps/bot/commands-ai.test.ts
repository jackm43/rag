import { assert, test } from "vitest";

import workflowsWorker from "@rag/workflows/src";
import { shouldUseAskWebSearch } from "@rag/discord/commands/ask";
import { decodeReplyJobEnvelope } from "@rag/discord/contracts";
import { createDbMock, createEnv, gatewayAiJob, sentEnvelope } from "../../helpers";

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

test("/ask web search heuristic detects current research requests", () => {
  assert.equal(
    shouldUseAskWebSearch("can you get me information on the best GPUs across nvidia and AMD currently?"),
    true,
  );
  assert.equal(shouldUseAskWebSearch("How do queue retries work?"), false);
  assert.equal(shouldUseAskWebSearch("What are the latest GPU prices?"), true);
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
