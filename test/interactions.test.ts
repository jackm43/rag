import { env as workerEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";

import worker from "../src/index";
import type { Env } from "../src/env";

const encoder = new TextEncoder();

const minimalEnv = (publicKeyHex: string): Env =>
  ({
    DISCORD_PUBLIC_KEY: publicKeyHex,
  }) as Env;

// Adds the real D1 binding (migrated per-file by test/apply-migrations.ts) plus
// the credentials dispatch needs to reach a command and edit the deferred
// reply: DISCORD_BOT_TOKEN for the bot-authenticated egress helper, and no
// ALLOWED_GUILD_IDS so every guild passes the allowlist gate.
const dispatchEnv = (publicKeyHex: string): Env =>
  ({
    DISCORD_PUBLIC_KEY: publicKeyHex,
    DISCORD_BOT_TOKEN: "bot-token",
    DB: workerEnv.DB,
  }) as unknown as Env;

const waitUntilCtx = () => {
  const tasks: Array<Promise<unknown>> = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => tasks.push(p) } as unknown as ExecutionContext,
    settle: () => Promise.all(tasks),
  };
};

const signedRequest = (
  payload: unknown,
  secretKey: Uint8Array,
  timestamp = String(Math.floor(Date.now() / 1000)),
) => {
  const rawBody = JSON.stringify(payload);
  const message = encoder.encode(timestamp + rawBody);
  const signature = nacl.sign.detached(message, secretKey);
  const signatureHex = Buffer.from(signature).toString("hex");

  return new Request("https://example.com/interactions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": signatureHex,
      "x-signature-timestamp": timestamp,
    },
    body: rawBody,
  });
};

describe("POST /interactions", () => {
  it("returns 401 for a bad signature", async () => {
    const validPair = nacl.sign.keyPair();
    const mismatchedPair = nacl.sign.keyPair();
    const env = minimalEnv(Buffer.from(validPair.publicKey).toString("hex"));
    const request = signedRequest({ type: 1 }, mismatchedPair.secretKey);
    const { ctx } = waitUntilCtx();

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(401);
  });

  it("returns 401 for a stale timestamp", async () => {
    const keyPair = nacl.sign.keyPair();
    const env = minimalEnv(Buffer.from(keyPair.publicKey).toString("hex"));
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 6 * 60);
    const request = signedRequest({ type: 1 }, keyPair.secretKey, staleTimestamp);
    const { ctx } = waitUntilCtx();

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(401);
  });

  it("returns 401 (not a throw) for a malformed signature header", async () => {
    const keyPair = nacl.sign.keyPair();
    const env = minimalEnv(Buffer.from(keyPair.publicKey).toString("hex"));
    const rawBody = JSON.stringify({ type: 1 });
    const request = new Request("https://example.com/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-ed25519": "not-hex",
        "x-signature-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body: rawBody,
    });
    const { ctx } = waitUntilCtx();

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(401);
  });

  it("responds to a valid PING with type 1 (PONG)", async () => {
    const keyPair = nacl.sign.keyPair();
    const env = minimalEnv(Buffer.from(keyPair.publicKey).toString("hex"));
    const request = signedRequest({ type: 1 }, keyPair.secretKey);
    const { ctx } = waitUntilCtx();

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: 1 });
  });

  it("responds to a valid slash command with a type 5 deferred ack and dispatches", async () => {
    const keyPair = nacl.sign.keyPair();
    const env = minimalEnv(Buffer.from(keyPair.publicKey).toString("hex"));
    const payload = {
      type: 2,
      id: "interaction-id",
      token: "interaction-token",
      data: { name: "ping" },
    };
    const request = signedRequest(payload, keyPair.secretKey);
    const { ctx, settle } = waitUntilCtx();

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: 5 });
    await settle();
  });

  it("dispatches a signed /ragboard command end-to-end: 200 type 5, then the deferred reply is edited over REST", async () => {
    const applicationId = "app-id-e2e";
    const invokerId = "500000000000000001";
    const raggedId = "500000000000000002";
    await workerEnv.DB.prepare(
      "INSERT INTO rag_totals (ragged_user_id, ragged_username, rag_count) VALUES (?, ?, ?)",
    )
      .bind(raggedId, "target", 3)
      .run();

    const keyPair = nacl.sign.keyPair();
    const env = dispatchEnv(Buffer.from(keyPair.publicKey).toString("hex"));
    const payload = {
      type: 2,
      id: "interaction-id-e2e",
      application_id: applicationId,
      token: "interaction-token-e2e",
      data: { name: "ragboard" },
      member: { user: { id: invokerId, username: "eve" } },
    };
    const request = signedRequest(payload, keyPair.secretKey);
    const { ctx, settle } = waitUntilCtx();

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      const response = await worker.fetch(request, env, ctx);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ type: 5 });

      // The command runs inside ctx.waitUntil(dispatch(...)); await it before
      // asserting on the fetch mock, or the PATCH may not have fired yet.
      await settle();
    } finally {
      globalThis.fetch = originalFetch;
    }

    const editCall = calls.find((call) =>
      call.url === `https://discord.com/api/v10/webhooks/${applicationId}/interaction-token-e2e/messages/@original`,
    );
    expect(editCall, "the deferred reply is PATCHed over REST").toBeDefined();
    expect(editCall?.init?.method).toBe("PATCH");
    const body = JSON.parse(String(editCall?.init?.body));
    expect(body.content).toContain("Ragboard");
    expect(body.content).toContain(`<@${raggedId}>`);
  });

  it("rejects a non-command interaction (autocomplete) with 400 instead of a deferred ack", async () => {
    const keyPair = nacl.sign.keyPair();
    const env = minimalEnv(Buffer.from(keyPair.publicKey).toString("hex"));
    const payload = { type: 4, id: "interaction-id", token: "interaction-token", data: { name: "ask" } };
    const request = signedRequest(payload, keyPair.secretKey);
    const { ctx, settle } = waitUntilCtx();

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(400);
    expect((await settle()).length, "nothing is dispatched").toBe(0);
  });

  it("returns 404 for unrelated routes", async () => {
    const request = new Request("https://example.com/unknown-route");
    const { ctx } = waitUntilCtx();

    const response = await worker.fetch(request, minimalEnv("unused"), ctx);

    expect(response.status).toBe(404);
  });
});
