import responseConfig from "./ai-config/discord-response.json";
import askWebSearchConfig from "./ai-config/ask-web-search.json";
import { errorMessage, logger } from "../logger";

// The worker binds a Workers KV namespace (AI_CONFIG) holding the same files
// that live in ai-config, keyed by their basename (see KV_KEYS). Editing a
// prompt is `edit file + push to KV` — a new isolate picks it up without a
// redeploy. The bundled imports above stay the source of truth and the fallback
// when KV misses or errors, so a fresh namespace or a KV outage never bricks
// the bot.
type ConfigEnv = { AI_CONFIG?: KVNamespace };

const KV_KEYS = {
  responseConfig: "discord-response.json",
  askWebSearchConfig: "ask-web-search.json",
  responseSystemPrompt: "discord-response-system-prompt.md",
  askWebSearchSystemPrompt: "ask-web-search-system-prompt.md",
} as const;

export type BotConfig = {
  responseModel: string;
  systemPrompt: string;
  maxTokens: number;
  temperature: number;
  historyLimit: number;
  gatewayId: string | null;
  askWebSearchModel: string;
  askWebSearchSystemPrompt: string;
  askWebSearchMaxOutputTokens: number;
  askWebSearchTemperature: number;
  askWebSearchMaxTurns: number;
  askWebSearchContextSize: "low" | "medium" | "high";
  askWebSearchGatewayId: string | null;
};

const parsePositiveInt = (value: string, fallback: number) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseTemperature = (value: string, fallback: number) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 2 ? parsed : fallback;
};

const parseSearchContextSize = (value: string): "low" | "medium" | "high" =>
  value === "low" || value === "medium" || value === "high" ? value : "medium";

const readKvText = async (env: ConfigEnv | undefined, key: string): Promise<string | null> => {
  const store = env?.AI_CONFIG;
  if (!store) {
    return null;
  }
  try {
    return await store.get(key);
  } catch (error) {
    // Any KV error falls back to the bundled value so an outage never bricks.
    logger.warn("ai_config_kv_read_failed", { key, error: errorMessage(error) });
    return null;
  }
};

// A KV override is merged over the bundled file field by field, so a partial
// or oddly-shaped document can only override what it actually provides —
// a missing `gatewayId` or a non-string `model` can never brick the bot.
const loadJsonConfig = async <T extends Record<string, unknown>>(
  env: ConfigEnv | undefined,
  key: string,
  fallback: T,
): Promise<T> => {
  const raw = await readKvText(env, key);
  if (raw === null) {
    return fallback;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      logger.warn("ai_config_kv_shape_invalid", { key });
      return fallback;
    }
    return { ...fallback, ...(parsed as Partial<T>) };
  } catch (error) {
    logger.warn("ai_config_kv_parse_failed", { key, error: errorMessage(error) });
    return fallback;
  }
};

const stringField = (value: unknown, fallback: string) =>
  typeof value === "string" && value.trim().length > 0 ? value : fallback;

const gatewayIdField = (value: unknown) => (typeof value === "string" && value.trim()) || null;

// The bundled fallback text lives in ./prompts, which statically imports the
// `.md` files. Loading it via dynamic import() keeps that import out of this
// module's static graph, so Node (scripts/register-commands.ts, via tsx) can
// import config.ts's callers without ever needing a `.md` loader — the
// dynamic import only actually runs on a KV miss/outage, which happens in the
// Workers runtime.
const loadPrompt = async (
  env: ConfigEnv | undefined,
  key: string,
  loadFallback: () => Promise<string>,
): Promise<string> => (await readKvText(env, key)) ?? (await loadFallback());

const resolveConfig = async (env?: ConfigEnv): Promise<BotConfig> => {
  const [responseCfg, askCfg, systemPrompt, askWebSearchSystemPrompt] = await Promise.all([
    loadJsonConfig(env, KV_KEYS.responseConfig, responseConfig),
    loadJsonConfig(env, KV_KEYS.askWebSearchConfig, askWebSearchConfig),
    loadPrompt(
      env,
      KV_KEYS.responseSystemPrompt,
      async () => (await import("./prompts")).discordResponseSystemPrompt,
    ),
    loadPrompt(
      env,
      KV_KEYS.askWebSearchSystemPrompt,
      async () => (await import("./prompts")).askWebSearchSystemPrompt,
    ),
  ]);

  return {
    responseModel: stringField(responseCfg.model, responseConfig.model),
    systemPrompt: systemPrompt.trim(),
    maxTokens: parsePositiveInt(String(responseCfg.maxTokens), 256),
    temperature: parseTemperature(String(responseCfg.temperature), 0.7),
    historyLimit: parsePositiveInt(String(responseCfg.historyLimit), 12),
    gatewayId: gatewayIdField(responseCfg.gatewayId),
    askWebSearchModel: stringField(askCfg.model, askWebSearchConfig.model),
    askWebSearchSystemPrompt: askWebSearchSystemPrompt.trim(),
    askWebSearchMaxOutputTokens: parsePositiveInt(String(askCfg.maxOutputTokens), 1200),
    askWebSearchTemperature: parseTemperature(String(askCfg.temperature), 0.3),
    askWebSearchMaxTurns: parsePositiveInt(String(askCfg.maxTurns), 4),
    askWebSearchContextSize: parseSearchContextSize(String(askCfg.searchContextSize)),
    askWebSearchGatewayId: gatewayIdField(askCfg.gatewayId),
  };
};

// Per-isolate-forever cache. KV values can change between deploys, but a deploy
// or isolate recycle is what re-resolves them; within one isolate the config is
// stable and read-once. env is captured on first call (it is the same binding
// object for an isolate's lifetime).
let cachedConfig: Promise<BotConfig> | null = null;

export const loadConfig = (env?: ConfigEnv): Promise<BotConfig> => {
  if (cachedConfig === null) {
    // A failed resolve must not be memoized, or one transient error would
    // pin every later call in the isolate to the same rejection.
    cachedConfig = resolveConfig(env).catch((error: unknown) => {
      cachedConfig = null;
      throw error;
    });
  }
  return cachedConfig;
};

// Test-only: production never clears the cache (see above). Tests reset it to
// exercise different KV states within a single isolate.
export const resetConfigCache = () => {
  cachedConfig = null;
};
