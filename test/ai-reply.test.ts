import { env } from "cloudflare:test";
import { afterEach, assert, beforeEach, test, vi } from "vitest";
import type { Env } from "../src/env";
import { deliverAiReply } from "../src/lib/ai/reply";
import { resetConfigCache } from "../src/lib/ai/config";
import { mediaResultString } from "../src/lib/ai/media-result";

const context = { kind: "ask", channelId: "200000000000000001", prompt: "Hello", requesterUsername: "alice" };
const testEnv = { DB: env.DB, DISCORD_BOT_TOKEN: "test-token" } as Env;
const completion = async () => ({
  result: { content: "unused raw text", model: "test-model", usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } },
  responseText: "Answer\nhttps://example.com <@123456789012345678>",
});

beforeEach(() => {
  resetConfigCache();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
});
afterEach(() => vi.restoreAllMocks());

const latest = () => env.DB.prepare("SELECT * FROM rag_ai_interactions ORDER BY id DESC LIMIT 1")
  .first<Record<string, unknown>>();

test("shared AI reply records the final delivered text and usage", async () => {
  assert.isTrue(await deliverAiReply(testEnv, context, completion));
  const row = await latest();
  assert.equal(row?.status, "ok");
  assert.equal(row?.model, "test-model");
  assert.equal(row?.total_tokens, 5);
  const request = vi.mocked(fetch).mock.calls[0][1];
  const payload = JSON.parse(String(request?.body));
  assert.equal(payload.content, "Answer\n<https://example.com>");
  assert.equal(row?.response_text, payload.content);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
});

test("a model failure records an error without posting a reply", async () => {
  assert.isFalse(await deliverAiReply(testEnv, context, async () => { throw new Error("model unavailable"); }));
  const row = await latest();
  assert.equal(row?.status, "error");
  assert.equal(row?.error_message, "model unavailable");
  assert.isNull(row?.response_text);
  assert.isNull(row?.ai_duration_ms);
  assert.equal(vi.mocked(fetch).mock.calls.length, 0);
});

test("a Discord failure preserves completion usage and attempted text in analytics", async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }));
  assert.isFalse(await deliverAiReply(testEnv, context, completion));
  const row = await latest();
  assert.equal(row?.status, "error");
  assert.equal(row?.error_message, "discord_channel_post_failed_503");
  assert.equal(row?.total_tokens, 5);
  assert.equal(row?.response_text, "Answer\n<https://example.com>");
});

test.each(["image", "audio"] as const)("media extraction accepts three provider envelopes for %s", (field) => {
  for (let depth = 0; depth < 3; depth += 1) {
    let payload: unknown = { [field]: "media" };
    for (let n = 0; n < depth; n += 1) payload = { result: payload };
    assert.equal(mediaResultString(payload, field), "media");
  }
  assert.isNull(mediaResultString({ result: { result: { result: { [field]: "too deep" } } } }, field));
  assert.isNull(mediaResultString({ [field]: 42 }, field));
  assert.equal(mediaResultString({ [field]: "", result: { [field]: "fallback" } }, field), "fallback");
});
