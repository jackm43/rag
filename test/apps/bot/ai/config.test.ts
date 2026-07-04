import { assert, test } from "vitest";

import { loadConfig, resetConfigCache } from "@rag/bot/lib/ai/config";
import responseConfig from "@rag/bot/lib/ai/ai-config/discord-response.json";
import askWebSearchConfig from "@rag/bot/lib/ai/ai-config/ask-web-search.json";
import responseSystemPrompt from "@rag/bot/lib/ai/ai-config/discord-response-system-prompt.md";
import askWebSearchSystemPrompt from "@rag/bot/lib/ai/ai-config/ask-web-search-system-prompt.md";

const KV_VALUES: Record<string, string> = {
  "discord-response.json": JSON.stringify({
    model: "kv/response-model",
    maxTokens: 42,
    temperature: 0.1,
    historyLimit: 5,
    gatewayId: "kv-response-gw",
  }),
  "ask-web-search.json": JSON.stringify({
    model: "kv/ask-model",
    maxOutputTokens: 99,
    temperature: 0.2,
    maxTurns: 2,
    searchContextSize: "high",
    gatewayId: "kv-ask-gw",
  }),
  "discord-response-system-prompt.md": "KV RESPONSE PROMPT",
  "ask-web-search-system-prompt.md": "KV ASK PROMPT",
};

// Minimal KV mock: get(key) resolves from `store`, counts reads, and can throw.
const kvMock = (store: Record<string, string>, options: { throwOnGet?: boolean } = {}) => {
  const reads: string[] = [];
  return {
    reads,
    binding: {
      get: async (key: string) => {
        reads.push(key);
        if (options.throwOnGet) {
          throw new Error("kv unavailable");
        }
        return key in store ? store[key] : null;
      },
    } as unknown as KVNamespace,
  };
};

test("loadConfig falls back to the bundled files when AI_CONFIG is unbound", async () => {
  resetConfigCache();
  const config = await loadConfig({});

  assert.equal(config.responseModel, responseConfig.model);
  assert.equal(config.maxTokens, responseConfig.maxTokens);
  assert.equal(config.gatewayId, responseConfig.gatewayId);
  assert.equal(config.systemPrompt, responseSystemPrompt.trim());
  assert.equal(config.askWebSearchModel, askWebSearchConfig.model);
  assert.equal(config.askWebSearchSystemPrompt, askWebSearchSystemPrompt.trim());
  assert.equal(config.askWebSearchContextSize, askWebSearchConfig.searchContextSize);
});

test("loadConfig reads prompts and config from AI_CONFIG when present", async () => {
  resetConfigCache();
  const kv = kvMock(KV_VALUES);
  const config = await loadConfig({ AI_CONFIG: kv.binding });

  assert.equal(config.responseModel, "kv/response-model");
  assert.equal(config.maxTokens, 42);
  assert.equal(config.temperature, 0.1);
  assert.equal(config.historyLimit, 5);
  assert.equal(config.gatewayId, "kv-response-gw");
  assert.equal(config.systemPrompt, "KV RESPONSE PROMPT");
  assert.equal(config.askWebSearchModel, "kv/ask-model");
  assert.equal(config.askWebSearchMaxOutputTokens, 99);
  assert.equal(config.askWebSearchMaxTurns, 2);
  assert.equal(config.askWebSearchContextSize, "high");
  assert.equal(config.askWebSearchSystemPrompt, "KV ASK PROMPT");
  assert.equal(config.askWebSearchGatewayId, "kv-ask-gw");
});

test("loadConfig falls back to bundled values on a KV miss (null)", async () => {
  resetConfigCache();
  // Only the response prompt is in KV; everything else misses and falls back.
  const kv = kvMock({ "discord-response-system-prompt.md": "KV RESPONSE PROMPT" });
  const config = await loadConfig({ AI_CONFIG: kv.binding });

  assert.equal(config.systemPrompt, "KV RESPONSE PROMPT", "present key comes from KV");
  assert.equal(config.responseModel, responseConfig.model, "missing key falls back to bundled");
  assert.equal(config.askWebSearchSystemPrompt, askWebSearchSystemPrompt.trim());
});

test("loadConfig falls back to bundled values when KV throws", async () => {
  resetConfigCache();
  const kv = kvMock(KV_VALUES, { throwOnGet: true });
  const config = await loadConfig({ AI_CONFIG: kv.binding });

  assert.equal(config.responseModel, responseConfig.model);
  assert.equal(config.systemPrompt, responseSystemPrompt.trim());
  assert.equal(config.askWebSearchModel, askWebSearchConfig.model);
});

test("loadConfig ignores malformed JSON in KV and falls back", async () => {
  resetConfigCache();
  const kv = kvMock({ "discord-response.json": "{not valid json" });
  const config = await loadConfig({ AI_CONFIG: kv.binding });

  assert.equal(config.responseModel, responseConfig.model);
});

test("loadConfig memoizes per isolate until the cache is reset", async () => {
  resetConfigCache();
  const kv = kvMock(KV_VALUES);

  const first = await loadConfig({ AI_CONFIG: kv.binding });
  const readsAfterFirst = kv.reads.length;
  assert.isAbove(readsAfterFirst, 0, "first resolve reads KV");

  // A second call returns the cached config without touching KV again.
  const second = await loadConfig({ AI_CONFIG: kv.binding });
  assert.strictEqual(second, first, "cached instance is reused");
  assert.equal(kv.reads.length, readsAfterFirst, "no further KV reads while cached");

  // Reset re-resolves (a deploy / isolate recycle is the production equivalent).
  resetConfigCache();
  await loadConfig({ AI_CONFIG: kv.binding });
  assert.isAbove(kv.reads.length, readsAfterFirst, "reset triggers a fresh read");
});
