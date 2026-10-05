// AI settings: one revisioned D1 row holding a typed document, checked on every read and save.
import { isObject } from "./lib/json.ts";

export const SETTINGS_SQL = "SELECT revision, document FROM ai_runtime_settings WHERE id = 1";
export const IMAGE_PARAMETERS = ["response_format", "aspect_ratio", "quality", "resolution"];
const API_FORMATS = ["chat-completions", "responses"] as const;
const REASONING_EFFORTS = ["low", "medium", "high", "xhigh"];
const HISTORY_LIMIT_MAX = 12;

export type ChatSettings = {
  model: string;
  prompt: string;
  apiFormat: (typeof API_FORMATS)[number];
  temperature: number;
  temperatureSupported: boolean;
  historyLimit: number;
  reasoningEffort?: string;
  gatewayId?: string;
};
export type ImageProfile = { model: string; gatewayId?: string; parameters: Record<string, string> };
export type Settings = {
  schemaVersion: 3;
  revision: string;
  updatedAt?: string;
  chat: ChatSettings;
  image: { activeProfile: string; profiles: Record<string, ImageProfile> };
};

export class SettingsError extends Error {
  name = "SettingsError";
}

const text = (value: unknown, max = 100_000): value is string =>
  typeof value === "string" && value.trim() !== "" && value.length <= max;
const gateway = (value: unknown) => value === undefined || (typeof value === "string" && /^[\w-]{1,64}$/.test(value));

/** Settings are edited data: check every field the bot relies on and keep only known fields. */
export function parseSettings(data: any): Settings {
  const check = (ok: boolean, field: string) => {
    if (!ok) throw new SettingsError(`Invalid setting: ${field}.`);
  };
  check(isObject(data) && data.schemaVersion === 3, "schemaVersion");
  check(text(data.revision, 200), "revision");
  const { chat, image } = data;
  check(isObject(chat), "chat");
  check(text(chat.model, 200), "chat.model");
  check(text(chat.prompt), "chat.prompt");
  check(API_FORMATS.includes(chat.apiFormat), "chat.apiFormat");
  check(typeof chat.temperature === "number" && chat.temperature >= 0 && chat.temperature <= 2, "chat.temperature");
  check(typeof chat.temperatureSupported === "boolean", "chat.temperatureSupported");
  check(Number.isInteger(chat.historyLimit) && chat.historyLimit >= 1 && chat.historyLimit <= HISTORY_LIMIT_MAX, "chat.historyLimit");
  check(chat.reasoningEffort === undefined || REASONING_EFFORTS.includes(chat.reasoningEffort), "chat.reasoningEffort");
  check(gateway(chat.gatewayId), "chat.gatewayId");
  check(isObject(image) && isObject(image.profiles) && Object.hasOwn(image.profiles, image.activeProfile), "image.activeProfile");
  const profiles = Object.entries<any>(image.profiles).map(([name, profile]) => {
    check(isObject(profile) && text(profile.model, 200), `image.profiles.${name}.model`);
    check(gateway(profile.gatewayId), `image.profiles.${name}.gatewayId`);
    const parameters = profile.parameters;
    check(
      isObject(parameters) &&
        Object.entries(parameters).every(([key, value]) => IMAGE_PARAMETERS.includes(key) && text(value, 200)),
      `image.profiles.${name}.parameters`,
    );
    return [name, { model: profile.model.trim(), ...(profile.gatewayId && { gatewayId: profile.gatewayId }), parameters: { ...parameters } }];
  });
  return {
    schemaVersion: 3,
    revision: data.revision,
    ...(typeof data.updatedAt === "string" && { updatedAt: data.updatedAt }),
    chat: {
      model: chat.model.trim(),
      prompt: chat.prompt,
      apiFormat: chat.apiFormat,
      temperature: chat.temperature,
      temperatureSupported: chat.temperatureSupported,
      historyLimit: chat.historyLimit,
      ...(chat.reasoningEffort && { reasoningEffort: chat.reasoningEffort }),
      ...(chat.gatewayId && { gatewayId: chat.gatewayId }),
    },
    image: { activeProfile: image.activeProfile, profiles: Object.fromEntries(profiles) },
  };
}

/** Each AI request reads the primary D1 row, so a saved change applies to the next request. */
export async function loadSettings(db: D1Database) {
  const row = await db.prepare(SETTINGS_SQL).first<{ revision: string; document: string }>();
  if (!row) throw new Error("AI settings are not initialized in D1");
  const settings = parseSettings(JSON.parse(row.document));
  if (settings.revision !== row.revision) throw new Error("settings revision mismatch");
  return settings;
}
