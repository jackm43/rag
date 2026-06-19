import responseConfig from "./ai-config/discord-response.json";
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

export const CONFIG_DEFAULTS = {
  ai_response_model: responseConfig.model,
  ai_roast_model: roastConfig.model,
  ai_system_prompt: "",
  ai_roast_system_prompt: "",
  ai_max_tokens: String(responseConfig.maxTokens),
  ai_temperature: String(responseConfig.temperature),
  ai_history_limit: String(responseConfig.historyLimit),
  ai_gateway_id: responseConfig.gatewayId,
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
};

const parsePositiveInt = (value: string, fallback: number) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseTemperature = (value: string, fallback: number) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 2 ? parsed : fallback;
};

export const loadConfig = async (_env: Env): Promise<BotConfig> => {
  const [systemPrompt, roastSystemPrompt] = await Promise.all([
    loadResponseSystemPrompt(),
    loadRoastSystemPrompt(),
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
  };
};
