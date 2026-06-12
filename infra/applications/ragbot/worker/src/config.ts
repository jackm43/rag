import { errorMessage, logger } from "../../../../sdk/ts/src";
import type { Env } from "./types";

export const CONFIG_DEFAULTS = {
  ai_response_model: "@cf/meta/llama-3.1-8b-instruct",
  ai_roast_model: "@cf/meta/llama-3.1-8b-instruct",
  ai_system_prompt:
    "You are Ragbot, a bot in a casual Discord server for friends. Reply in plain text, briefly and directly. Default to one or two short sentences and match the length of your reply to the question. Dry humour is welcome when it fits, but never force banter and never pad your answers. Only write something long when the question genuinely needs it.",
  ai_roast_system_prompt:
    "You are a sharp, inventive roast writer for a Discord 'rag' bot. Write ONE original roast sentence under 140 characters teasing both people by display name. Be creative and specific: vary your imagery, reach for unexpected comparisons, and never settle for generic or formulaic phrasing. Plain text only, exactly one sentence. Never include @ mentions, Discord IDs, tags, or handles. Be playful and a little mean, never genuinely cruel.",
  ai_max_tokens: "256",
  ai_temperature: "0.7",
  ai_history_limit: "12",
  ai_gateway_id: "",
} as const;

export type ConfigKey = keyof typeof CONFIG_DEFAULTS;

export const CONFIG_KEYS = Object.keys(CONFIG_DEFAULTS) as ConfigKey[];

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
};

const parsePositiveInt = (value: string, fallback: number) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const parseTemperature = (value: string, fallback: number) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 2 ? parsed : fallback;
};

export const getSettings = async (env: Env): Promise<Record<string, string>> => {
  try {
    const result = await env.DB.prepare("SELECT key, value FROM rag_settings").run<{
      key: string;
      value: string;
    }>();
    return Object.fromEntries((result.results ?? []).map((row) => [row.key, row.value]));
  } catch (error) {
    logger.warn("settings_load_failed", { error: errorMessage(error) });
    return {};
  }
};

export const loadConfig = async (env: Env): Promise<BotConfig> => {
  const settings = await getSettings(env);
  const value = (key: ConfigKey) => {
    const stored = settings[key]?.trim();
    return stored && stored.length > 0 ? stored : CONFIG_DEFAULTS[key];
  };

  return {
    responseModel: value("ai_response_model"),
    roastModel: value("ai_roast_model"),
    systemPrompt: value("ai_system_prompt"),
    roastSystemPrompt: value("ai_roast_system_prompt"),
    maxTokens: parsePositiveInt(value("ai_max_tokens"), 256),
    temperature: parseTemperature(value("ai_temperature"), 0.7),
    historyLimit: parsePositiveInt(value("ai_history_limit"), 12),
    gatewayId: value("ai_gateway_id") || null,
  };
};

export const setSetting = async (env: Env, key: ConfigKey, value: string) => {
  await env.DB.prepare(
    "INSERT INTO rag_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(key, value)
    .run();
};

export const deleteSetting = async (env: Env, key: ConfigKey) => {
  await env.DB.prepare("DELETE FROM rag_settings WHERE key = ?").bind(key).run();
};
