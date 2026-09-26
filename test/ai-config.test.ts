import { assert, expect, beforeEach, test } from "vitest";

import { loadConfig, resetConfigCache } from "../src/lib/ai/config";
import responseConfig from "../src/lib/ai/ai-config/discord-response.json";
import askWebSearchConfig from "../src/lib/ai/ai-config/ask-web-search.json";
import responseSystemPrompt from "../src/lib/ai/ai-config/discord-response-system-prompt.md";
import askWebSearchSystemPrompt from "../src/lib/ai/ai-config/ask-web-search-system-prompt.md";

const KV_VALUES: Record<string, string> = {
  "discord-response.json": JSON.stringify({
    model: "kv/response-model", maxTokens: 42, temperature: 0.1, historyLimit: 5, gatewayId: "kv-response-gw",
  }),
  "ask-web-search.json": JSON.stringify({
    model: "kv/ask-model", maxOutputTokens: 99, temperature: 0.2, maxTurns: 2,
    searchContextSize: "high", gatewayId: "kv-ask-gw",
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

beforeEach(resetConfigCache);
const bundled = {
  responseModel: responseConfig.model, maxTokens: responseConfig.maxTokens, gatewayId: responseConfig.gatewayId,
  systemPrompt: responseSystemPrompt.trim(), askWebSearchModel: askWebSearchConfig.model,
  askWebSearchSystemPrompt: askWebSearchSystemPrompt.trim(), askWebSearchContextSize: askWebSearchConfig.searchContextSize,
};
test.each([
  { name: "loadConfig falls back to the bundled files when AI_CONFIG is unbound", store: undefined, expected: bundled },
  {
    name: "loadConfig reads prompts and config from AI_CONFIG when present", store: KV_VALUES,
    expected: { responseModel: "kv/response-model", maxTokens: 42, temperature: 0.1, historyLimit: 5,
      gatewayId: "kv-response-gw", systemPrompt: "KV RESPONSE PROMPT", askWebSearchModel: "kv/ask-model",
      askWebSearchMaxOutputTokens: 99, askWebSearchMaxTurns: 2, askWebSearchContextSize: "high",
      askWebSearchSystemPrompt: "KV ASK PROMPT", askWebSearchGatewayId: "kv-ask-gw" },
  },
  { name: "loadConfig falls back to bundled values on a KV miss (null)",
    store: { "discord-response-system-prompt.md": "KV RESPONSE PROMPT" },
    expected: { ...bundled, systemPrompt: "KV RESPONSE PROMPT" } },
  { name: "loadConfig falls back to bundled values when KV throws", store: KV_VALUES, throwOnGet: true, expected: bundled },
  { name: "loadConfig ignores malformed JSON in KV and falls back",
    store: { "discord-response.json": "{not valid json" }, expected: bundled },
  {
    name: "loadConfig falls back field by field when a KV document is mis-shaped",
    // Missing gatewayId, non-string model, and invalid context size must fall back independently.
    store: { "discord-response.json": JSON.stringify({ maxTokens: 12, model: 42 }),
      "ask-web-search.json": JSON.stringify({ searchContextSize: "huge", gatewayId: "" }) },
    expected: { ...bundled, maxTokens: 12, askWebSearchContextSize: "medium", askWebSearchGatewayId: null },
  },
].map(row => [row.name, row] as const))("%s", async (_, { store, expected, throwOnGet }) => {
  const config = await loadConfig({ AI_CONFIG: store ? kvMock(store as Record<string, string>, { throwOnGet }).binding : undefined });
  expect(config).toMatchObject(expected);
});

test("loadConfig memoizes per isolate until the cache is reset", async () => {
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
