import { query, baseEnv, signedRequest, signingFixture, withFetch } from "./helpers";
import { env as workerEnv } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src/index";
import type { Env } from "../src/env";

const minimalEnv = (publicKeyHex: string): Env => ({ DISCORD_PUBLIC_KEY: publicKeyHex }) as Env;
const dispatchEnv = (publicKeyHex: string) => baseEnv({ DISCORD_PUBLIC_KEY: publicKeyHex });

const waitUntilCtx = () => {
  const tasks: Array<Promise<unknown>> = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => tasks.push(p) } as unknown as ExecutionContext,
    settle: () => Promise.all(tasks),
  };
};

describe("POST /interactions", () => {
  it.each([
    ["returns 401 for a bad signature", "wrong"],
    ["returns 401 for a stale timestamp", "stale"],
    ["returns 401 (not a throw) for a malformed signature header", "malformed"],
  ])("%s", async (_, scenario) => {
    const { publicKeyHex, secretKey } = signingFixture();
    const timestamp = String(Math.floor(Date.now() / 1000) - (scenario === "stale" ? 360 : 0));
    const { request } = signedRequest({ type: 1 }, scenario === "wrong" ? signingFixture().secretKey : secretKey, timestamp);
    if (scenario === "malformed") request.headers.set("x-signature-ed25519", "not-hex");
    const { ctx } = waitUntilCtx();
    expect((await worker.fetch(request, minimalEnv(publicKeyHex), ctx)).status).toBe(401);
  });

  it("responds to a valid PING with type 1 (PONG)", async () => {
    const { publicKeyHex, secretKey } = signingFixture();
    const env = minimalEnv(publicKeyHex);
    const { request } = signedRequest({ type: 1 }, secretKey);
    const { ctx } = waitUntilCtx();

    const response = await worker.fetch(request, env, ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: 1 });
  });

  it("responds to a valid slash command with a type 5 deferred ack and dispatches", async () => {
    const { publicKeyHex, secretKey } = signingFixture();
    const env = minimalEnv(publicKeyHex);
    const payload = {
      type: 2,
      id: "interaction-id",
      token: "interaction-token",
      data: { name: "ping" },
    };
    const { request } = signedRequest(payload, secretKey);
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
    await query("INSERT INTO rag_totals (ragged_user_id, ragged_username, rag_count) VALUES (?, ?, ?)", raggedId, "target", 3).run();

    const { publicKeyHex, secretKey } = signingFixture();
    const env = dispatchEnv(publicKeyHex);
    const payload = {
      type: 2,
      id: "interaction-id-e2e",
      application_id: applicationId,
      token: "interaction-token-e2e",
      data: { name: "ragboard" },
      member: { user: { id: invokerId, username: "eve" } },
    };
    const { request } = signedRequest(payload, secretKey);
    const { ctx, settle } = waitUntilCtx();

    const calls = await withFetch(() => undefined, async calls => {
      const response = await worker.fetch(request, env, ctx);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ type: 5 });
      // Wait for the deferred command before inspecting its REST call.
      await settle();
      return calls;
    });

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
    const { publicKeyHex, secretKey } = signingFixture();
    const env = minimalEnv(publicKeyHex);
    const payload = { type: 4, id: "interaction-id", token: "interaction-token", data: { name: "ask" } };
    const { request } = signedRequest(payload, secretKey);
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
