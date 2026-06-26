import responseConfig from "./ai-config/discord-response.json";
import askWebSearchConfig from "./ai-config/ask-web-search.json";
import roastConfig from "./ai-config/rag-roast.json";
import type { Env } from "./types";

const isNodeRuntime = () =>
  typeof process !== "undefined" &&
  process.versions?.node !== undefined &&
  process.versions?.workerd === undefined &&
  typeof WebSocketPair === "undefined";

const readPromptFile = async (filename: string) => {
  const fs = await import("node:fs/promises");
  return fs.readFile(new URL(`./ai-config/${filename}`, import.meta.url), "utf8");
};

const loadResponseSystemPrompt = async () =>
  isNodeRuntime()
    ? readPromptFile("discord-response-system-prompt.md")
    : (await import("./ai-config/discord-response-system-prompt.md")).default;

const loadRoastSystemPrompt = async () =>
  isNodeRuntime()
    ? readPromptFile("rag-roast-system-prompt.md")
    : (await import("./ai-config/rag-roast-system-prompt.md")).default;

const loadAskWebSearchSystemPrompt = async () =>
  isNodeRuntime()
    ? readPromptFile("ask-web-search-system-prompt.md")
    : (await import("./ai-config/ask-web-search-system-prompt.md")).default;

export const CONFIG_DEFAULTS = {
  ai_response_model: responseConfig.model,
  ai_roast_model: roastConfig.model,
  ai_ask_web_search_model: askWebSearchConfig.model,
  ai_system_prompt: "",
  ai_roast_system_prompt: "",
  ai_ask_web_search_system_prompt: "",
  ai_max_tokens: String(responseConfig.maxTokens),
  ai_temperature: String(responseConfig.temperature),
  ai_history_limit: String(responseConfig.historyLimit),
  ai_gateway_id: responseConfig.gatewayId,
  ai_ask_web_search_gateway_id: askWebSearchConfig.gatewayId,
} as const;

export type ConfigKey = keyof typeof CONFIG_DEFAULTS;

export const isConfigKey = (key: string): key is ConfigKey => key in CONFIG_DEFAULTS;

export type BotConfig = {
  responseModel: string;
  roastModel: string;
  systemPrompt: string;
  roastSystemPrompt: string;
  maxTokens: number;
  temperature: number;
  historyLimit: number;
  gatewayId: string | null;
  roastMaxTokens: number;
  roastTemperature: number;
  roastGatewayId: string | null;
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

export const loadConfig = async (_env: Env): Promise<BotConfig> => {
  const [systemPrompt, roastSystemPrompt, askWebSearchSystemPrompt] = await Promise.all([
    loadResponseSystemPrompt(),
    loadRoastSystemPrompt(),
    loadAskWebSearchSystemPrompt(),
  ]);

  return {
    responseModel: responseConfig.model,
    roastModel: roastConfig.model,
    systemPrompt: systemPrompt.trim(),
    roastSystemPrompt: roastSystemPrompt.trim(),
    maxTokens: parsePositiveInt(String(responseConfig.maxTokens), 256),
    temperature: parseTemperature(String(responseConfig.temperature), 0.7),
    historyLimit: parsePositiveInt(String(responseConfig.historyLimit), 12),
    gatewayId: responseConfig.gatewayId.trim() || null,
    roastMaxTokens: parsePositiveInt(String(roastConfig.maxTokens), 64),
    roastTemperature: parseTemperature(String(roastConfig.temperature), 0.95),
    roastGatewayId: roastConfig.gatewayId.trim() || null,
    askWebSearchModel: askWebSearchConfig.model,
    askWebSearchSystemPrompt: askWebSearchSystemPrompt.trim(),
    askWebSearchMaxOutputTokens: parsePositiveInt(String(askWebSearchConfig.maxOutputTokens), 1200),
    askWebSearchTemperature: parseTemperature(String(askWebSearchConfig.temperature), 0.3),
    askWebSearchMaxTurns: parsePositiveInt(String(askWebSearchConfig.maxTurns), 4),
    askWebSearchContextSize: parseSearchContextSize(askWebSearchConfig.searchContextSize),
    askWebSearchGatewayId: askWebSearchConfig.gatewayId.trim() || null,
  };
};
