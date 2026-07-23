import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";

import worker from "../src/index";
import type { Env } from "../src/env";

const encoder = new TextEncoder();

const minimalEnv = (publicKeyHex: string): Env =>
  ({
    DISCORD_PUBLIC_KEY: publicKeyHex,
  }) as Env;

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

  it("returns 404 for unrelated routes", async () => {
    const request = new Request("https://example.com/unknown-route");
    const { ctx } = waitUntilCtx();

    const response = await worker.fetch(request, minimalEnv("unused"), ctx);

    expect(response.status).toBe(404);
  });
});
