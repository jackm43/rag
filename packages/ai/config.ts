import responseConfig from "./ai-config/discord-response.json";
import askWebSearchConfig from "./ai-config/ask-web-search.json";
import responseSystemPromptText from "./ai-config/discord-response-system-prompt.md";
import askWebSearchSystemPromptText from "./ai-config/ask-web-search-system-prompt.md";
import { errorMessage, logger } from "../logger";

// The brain worker binds a Workers KV namespace (AI_CONFIG) holding the same
// files that live in ai-config, keyed by their basename (see KV_KEYS and
// scripts/push-config.ts). Editing a prompt is `edit file + npm run config:push`
// — a new isolate picks it up without a redeploy. The bundled imports above stay
// the source of truth config:push uploads and the fallback when KV misses or
// errors, so a fresh namespace or a KV outage never bricks the bot.
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

const loadJsonConfig = async <T>(
  env: ConfigEnv | undefined,
  key: string,
  fallback: T,
): Promise<T> => {
  const raw = await readKvText(env, key);
  if (raw === null) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    logger.warn("ai_config_kv_parse_failed", { key, error: errorMessage(error) });
    return fallback;
  }
};

const loadPrompt = async (
  env: ConfigEnv | undefined,
  key: string,
  fallback: string,
): Promise<string> => (await readKvText(env, key)) ?? fallback;

const resolveConfig = async (env?: ConfigEnv): Promise<BotConfig> => {
  const [responseCfg, askCfg, systemPrompt, askWebSearchSystemPrompt] = await Promise.all([
    loadJsonConfig(env, KV_KEYS.responseConfig, responseConfig),
    loadJsonConfig(env, KV_KEYS.askWebSearchConfig, askWebSearchConfig),
    loadPrompt(env, KV_KEYS.responseSystemPrompt, responseSystemPromptText),
    loadPrompt(env, KV_KEYS.askWebSearchSystemPrompt, askWebSearchSystemPromptText),
  ]);

  return {
    responseModel: responseCfg.model,
    systemPrompt: systemPrompt.trim(),
    maxTokens: parsePositiveInt(String(responseCfg.maxTokens), 256),
    temperature: parseTemperature(String(responseCfg.temperature), 0.7),
    historyLimit: parsePositiveInt(String(responseCfg.historyLimit), 12),
    gatewayId: responseCfg.gatewayId.trim() || null,
    askWebSearchModel: askCfg.model,
    askWebSearchSystemPrompt: askWebSearchSystemPrompt.trim(),
    askWebSearchMaxOutputTokens: parsePositiveInt(String(askCfg.maxOutputTokens), 1200),
    askWebSearchTemperature: parseTemperature(String(askCfg.temperature), 0.3),
    askWebSearchMaxTurns: parsePositiveInt(String(askCfg.maxTurns), 4),
    askWebSearchContextSize: parseSearchContextSize(askCfg.searchContextSize),
    askWebSearchGatewayId: askCfg.gatewayId.trim() || null,
  };
};

// Per-isolate-forever cache. KV values can change between deploys, but a deploy
// or isolate recycle is what re-resolves them; within one isolate the config is
// stable and read-once. env is captured on first call (it is the same binding
// object for an isolate's lifetime).
let cachedConfig: Promise<BotConfig> | null = null;

export const loadConfig = (env?: ConfigEnv): Promise<BotConfig> =>
  (cachedConfig ??= resolveConfig(env));

// Test-only: production never clears the cache (see above). Tests reset it to
// exercise different KV states within a single isolate.
export const resetConfigCache = () => {
  cachedConfig = null;
};
