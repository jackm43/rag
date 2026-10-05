// Dev UI settings: drafts, reviewed saves to local or live D1, and the Cloudflare-credit model catalog.
import { chatConfig, parseSettings, SETTINGS_SQL, type Settings } from "../src/ai.ts";
import type { DevEnv } from "./index.ts";

type Overrides = Record<string, any>;
type Resources = Record<string, string>;
type Config = ReturnType<typeof resolveConfig>;

const SAVE_SQL = `INSERT INTO ai_runtime_settings (id, revision, document) VALUES (1, ?, ?)
ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, document = excluded.document
WHERE ai_runtime_settings.revision = ?`;

const HISTORY_SQL = `SELECT id, kind, prompt, response_text, model, status, requester_username, created_at
FROM rag_ai_interactions
WHERE ((? = 'bicture' AND kind = 'bicture') OR (? = 'chat' AND kind = 'channel_reply'))
  AND (? IS NULL OR id < ?)
  AND (? = '' OR instr(lower(prompt), lower(?)) > 0)
ORDER BY id DESC LIMIT 26`;

export class HttpError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const invalidInput = () => new HttpError("Invalid simulation input.");
const catalogUnavailable = () => new HttpError("Cannot verify Cloudflare-credit access. Retry the model list.", 503);

export const isObject = (value: unknown): value is Record<string, any> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonical = (value: any): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : isObject(value)
      ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
      : JSON.stringify(value);

export async function sha256(value: unknown) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// JSON resources compare by value, so formatting never counts as a change.
const normalize = (resources: Resources) =>
  Object.fromEntries(Object.entries(resources).map(([key, value]) => [key, key.endsWith(".json") ? JSON.parse(value) : value]));

const activeProfile = (config: Config) => config.image.profiles[config.image.activeProfile];

/** Client overrides, minus the fields the server derives from the model catalog. */
export function draftOverrides(raw: unknown): Overrides {
  const overrides = { ...(isObject(raw) ? raw : {}) };
  for (const key of ["imageParameters", "chatApiFormat", "chatTemperatureSupported"]) delete overrides[key];
  for (const [key, value] of Object.entries(overrides)) {
    const valid =
      key === "temperature"
        ? typeof value === "number" && value >= 0 && value <= 2
        : key === "historyLimit"
          ? Number.isInteger(value) && value >= 1 && value <= 12
          : ["model", "systemPrompt", "imageProfile", "imageModel", "imageAspectRatio", "imageQuality", "imageResolution"].includes(key) &&
            typeof value === "string" &&
            value.length <= 100_000;
    if (!valid) throw invalidInput();
  }
  return overrides;
}

/** Apply overrides to a copy of the saved resources. */
export function applyDraft(overrides: Overrides, resources: Resources): Resources {
  const chat = JSON.parse(resources["discord-response.json"]);
  // Reasoning support is model-specific; do not carry it to another model.
  if (overrides.model && overrides.model !== chat.model) delete chat.reasoningEffort;
  const chatFields = { model: "model", temperature: "temperature", historyLimit: "historyLimit", apiFormat: "chatApiFormat", temperatureSupported: "chatTemperatureSupported" };
  for (const [field, source] of Object.entries(chatFields)) {
    if (overrides[source] != null && overrides[source] !== "") chat[field] = overrides[source];
  }
  const image = JSON.parse(resources["bicture-image.json"]);
  image.activeProfile = overrides.imageProfile || image.activeProfile;
  if (!Object.hasOwn(image.profiles, image.activeProfile)) throw invalidInput();
  const profile = image.profiles[image.activeProfile];
  const imageFields = { model: "imageModel", aspectRatio: "imageAspectRatio", quality: "imageQuality", resolution: "imageResolution" };
  for (const [field, source] of Object.entries(imageFields)) if (overrides[source]) profile[field] = overrides[source];
  if (overrides.imageParameters) profile.parameters = overrides.imageParameters;
  const prompt = overrides.systemPrompt;
  return {
    "bicture-image.json": JSON.stringify(image),
    "discord-response-system-prompt.md": typeof prompt === "string" && prompt.trim() ? prompt : resources["discord-response-system-prompt.md"],
    "discord-response.json": JSON.stringify(chat),
  };
}

/** The settings a draft resolves to, in the shape the UI shows. */
export function resolveConfig(overrides: Overrides, resources: Resources) {
  const values = applyDraft(overrides, resources);
  const chat = chatConfig(parseSettings(JSON.stringify({ schemaVersion: 2, revision: "draft", resources: values })));
  return {
    image: JSON.parse(values["bicture-image.json"]),
    responseModel: chat.model,
    chatApiFormat: chat.apiFormat,
    chatReasoningEffort: chat.reasoningEffort ?? null,
    systemPrompt: chat.prompt,
    temperature: chat.temperature,
    historyLimit: chat.historyLimit,
    gatewayId: chat.gatewayId ?? null,
  };
}

/** A draft as the settings row a simulation reads; unsaved changes get a `+draft-` revision. */
export async function draftRow(overrides: Overrides, resources: Resources, revision: string) {
  const values = applyDraft(overrides, resources);
  const checksum = await sha256(normalize(values));
  const used = checksum === (await sha256(normalize(resources))) ? revision : `${revision}+draft-${checksum.slice(0, 12)}`;
  return { revision: used, document: JSON.stringify({ schemaVersion: 2, revision: used, resources: values }) };
}

let saving: Promise<unknown> = Promise.resolve();

export class SettingsEditor {
  env: DevEnv;
  target: "local" | "live";

  constructor(env: DevEnv, target: unknown) {
    if (target !== "local" && target !== "live") throw new HttpError("Choose local sandbox or live bot settings.");
    this.env = env;
    this.target = target;
  }

  // The local sandbox is the dev database; the live bot's D1 database is reached through the API.
  async query(sql: string, params: unknown[] = []): Promise<{ results: any[]; meta: any }> {
    if (this.target === "local") return this.env.DB.prepare(sql).bind(...params).all<any>();
    const { CF_ACCOUNT_ID: account, D1_DATABASE_ID: database } = this.env;
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.env.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ sql, params }),
    });
    if (!response.ok) {
      throw new HttpError("Cloudflare could not read or save settings. Check D1 permissions and migrations; reload before retrying.", 503);
    }
    const payload: any = await response.json();
    if (!payload.success || payload.result?.length !== 1 || !payload.result[0].success) {
      throw new HttpError("D1 did not confirm the operation. Check migrations and reload settings.", 503);
    }
    return payload.result[0];
  }

  async history({ page, before = null, search = "" }: any) {
    if (
      (page !== "chat" && page !== "bicture") ||
      (before !== null && !(Number.isInteger(before) && before >= 1)) ||
      typeof search !== "string" ||
      search.length > 500
    ) {
      throw new HttpError("Invalid prompt history filter.");
    }
    const { results } = await this.query(HISTORY_SQL, [page, page, before, before, search, search]);
    return { entries: results.slice(0, 25), next: results.length > 25 ? results[24].id : null };
  }

  async read() {
    const [row] = (await this.query(SETTINGS_SQL)).results;
    if (!row) {
      throw new HttpError("AI settings are not initialized in D1. Run the settings initialization command for this destination.", 503);
    }
    const settings = parseSettings(row.document);
    if (settings.revision !== row.revision) throw new HttpError("Saved settings revision is invalid.", 409);
    return this.describe(settings);
  }

  async preview(body: any) {
    const { current, resources, changes } = await this.prepare(body);
    return { changes, reviewId: await sha256([this.target, current.revision, resources]) };
  }

  // One save at a time here; the conditional write also rejects saves made elsewhere since loading.
  save(body: any) {
    const result = saving.then(async () => {
      const { current, resources, changes } = await this.prepare(body);
      if (body.reviewId !== (await sha256([this.target, current.revision, resources]))) {
        throw new HttpError("Review these exact settings before saving.", 409);
      }
      if (!changes.length) throw new HttpError("There are no changes to save.");
      const settings: Settings = { schemaVersion: 2, revision: crypto.randomUUID().replaceAll("-", ""), updatedAt: new Date().toISOString(), resources };
      const document = JSON.stringify(settings);
      parseSettings(document);
      const { meta } = await this.query(SAVE_SQL, [settings.revision, document, current.revision]);
      if (meta?.changes !== 1) throw new HttpError("Settings changed during your save. Reload and review again.", 409);
      return this.describe(settings);
    });
    saving = result.catch(() => {});
    return result;
  }

  private describe(settings: Settings) {
    return { target: this.target, revision: settings.revision, resources: settings.resources, config: resolveConfig({}, settings.resources) };
  }

  private async prepare(body: any) {
    const current = await this.read();
    if (body.baseRevision !== current.revision) {
      throw new HttpError("Settings changed since you loaded them. Reload and review again.", 409);
    }
    if (body.page !== "chat" && body.page !== "bicture") throw new HttpError("This command has no editable AI settings.");
    const image = body.page === "bicture";
    const overrides = draftOverrides(body.overrides);
    if (Object.keys(overrides).some((key) => key.startsWith("image") !== image)) {
      throw new HttpError("Review settings for one page at a time.");
    }
    if (image || "model" in overrides || "temperature" in overrides) {
      Object.assign(overrides, await catalogOverrides(this.env, overrides, current.resources, image));
    } else {
      await checkModel(this.env, resolveConfig(overrides, current.resources), "chat");
    }
    const resources = applyDraft(overrides, current.resources);
    const [before, after] = [normalize(current.resources), normalize(resources)];
    const changes = Object.keys(resources)
      .filter((key) => canonical(before[key]) !== canonical(after[key]))
      .map((resource) => ({ resource, before: current.resources[resource], after: resources[resource] }));
    return { current, resources, changes };
  }
}

/** Settings derived from the selected model: image parameters, or chat format and temperature support. */
export async function catalogOverrides(env: DevEnv, overrides: Overrides, resources: Resources, image: boolean) {
  const config = resolveConfig(overrides, resources);
  if (image) {
    const model = await checkModel(env, config, "image");
    return { imageParameters: imageParameters(model, activeProfile(config), overrides) };
  }
  const model = await checkModel(env, config, "chat");
  const range = model.temperature;
  if (range) {
    const temperature = overrides.temperature ?? config.temperature;
    if (!(temperature >= range.minimum && temperature <= range.maximum)) {
      throw new HttpError(`Choose a temperature from ${range.minimum} to ${range.maximum} for this model.`);
    }
  } else if ("temperature" in overrides) {
    throw new HttpError("Temperature is not supported by this model.");
  }
  return { chatApiFormat: model.apiFormat, chatTemperatureSupported: Boolean(range) };
}

// Send only parameters the model's schema accepts, with values it allows.
function imageParameters(model: any, profile: any, overrides: Overrides) {
  const parameters: Record<string, string> = {};
  const fields = [
    ["aspect_ratio", "imageAspectRatio", "aspectRatio"],
    ["quality", "imageQuality", "quality"],
    ["resolution", "imageResolution", "resolution"],
    ["response_format", "", "responseFormat"],
  ];
  for (const [field, source, key] of fields) {
    const spec = model.parameters[field];
    const explicit = source && overrides[source];
    if (!spec) {
      if (explicit) throw new HttpError("The selected image model does not support that setting.");
      continue;
    }
    let value = explicit || profile[key];
    if (spec.enum && !spec.enum.includes(value)) {
      if (explicit) throw new HttpError("Select an available value for this image model.");
      value = spec.default;
    }
    if (value) parameters[field] = value;
  }
  return parameters;
}

const PROVIDER_ROUTES = new Map([
  ["xai", ["xai", "grok"]],
  ["google", ["google", "google-ai-studio", "google-vertex-ai"]],
]);
const catalogCache = new Map<string, { at: number; value: { chat: any[]; image: any[]; checkedAt: number } }>();

async function cloudflare(env: DevEnv, path: string): Promise<any> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/${path}`, {
    headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
    signal: AbortSignal.timeout(15_000),
  });
  const payload: any = response.ok ? await response.json() : null;
  if (!payload?.success) throw catalogUnavailable();
  return payload;
}

async function pages(env: DevEnv, path: string) {
  const rows: any[] = [];
  for (let page = 1; page <= 20; page++) {
    const { result, result_info: info } = await cloudflare(env, `${path}?per_page=100&page=${page}`);
    if (!Array.isArray(result)) throw catalogUnavailable();
    rows.push(...result);
    const total = info?.total_count;
    if (!result.length || (Number.isInteger(total) && rows.length >= total)) return rows;
    if (total == null && result.length < (info?.per_page ?? 100)) return rows;
  }
  throw catalogUnavailable();
}

// Whether a gateway bills models to Cloudflare credits, and which providers use stored keys instead.
async function billing(env: DevEnv, gateway: unknown) {
  if (typeof gateway !== "string" || !/^[\w-]{1,64}$/.test(gateway)) throw catalogUnavailable();
  const prefix = `ai-gateway/gateways/${gateway}`;
  const [settings, keys] = await Promise.all([cloudflare(env, prefix), pages(env, `${prefix}/provider_configs`)]);
  // Only provider slugs are kept; key IDs and previews never reach the UI.
  const blocked = new Set<string>(keys.filter((key) => key.alias === "default").map((key) => key.provider_slug));
  return { unified: settings.result.byok_only === false, blocked };
}

function creditRoute(provider: string, providers: string[], route: { unified: boolean; blocked: Set<string> }) {
  const names = [...(PROVIDER_ROUTES.get(provider) ?? [provider]), ...providers];
  return Boolean(provider) && provider !== "workers-ai" && route.unified && !names.some((name) => route.blocked.has(name));
}

/** Chat and image models from the live account catalog that can run on Cloudflare credits. */
export async function loadCatalog(env: DevEnv, config: Config, refresh = false) {
  const gateways = [config.gatewayId, activeProfile(config).gatewayId];
  const key = gateways.join("|");
  const cached = catalogCache.get(key);
  if (!refresh && cached && Date.now() - cached.at < 300_000) return cached.value;
  const [models, chatRoute, imageRoute] = await Promise.all([
    pages(env, "ai/catalog/models"),
    billing(env, gateways[0]),
    billing(env, gateways[1]),
  ]);
  const chat = [];
  const image = [];
  for (const model of models) {
    const formats: string[] = model.request_formats ?? [];
    const providers: string[] = (model.provider_details ?? []).map((detail: any) => detail.id).filter(Boolean);
    const entry = { id: model.model_id, name: model.name ?? model.model_id, provider: model.provider_id, providers };
    if (
      model.task === "Text Generation" &&
      creditRoute(model.provider_id, providers, chatRoute) &&
      (formats.includes("chat-completions") || formats.includes("responses"))
    ) {
      chat.push({ ...entry, apiFormat: formats.includes("chat-completions") ? "chat-completions" : "responses" });
    } else if (model.task === "Text-to-Image" && creditRoute(model.provider_id, providers, imageRoute) && !model.supports_async) {
      image.push(entry);
    }
  }
  const value = {
    chat: await mapLimited(chat, async (model) => ({ ...model, temperature: await temperatureSupport(env, model) })),
    image: (await mapLimited(image, (model) => imageSupport(env, model))).filter(Boolean),
    checkedAt: Math.floor(Date.now() / 1000),
  };
  catalogCache.set(key, { at: Date.now(), value });
  return value;
}

/** Confirm the selected model is in the credit catalog and still routes to Cloudflare credits. */
async function checkModel(env: DevEnv, config: Config, group: "chat" | "image") {
  const catalog = await loadCatalog(env, config);
  const profile = activeProfile(config);
  const selected = group === "chat" ? config.responseModel : profile.model;
  const model = catalog[group].find((entry) => entry.id === selected);
  if (!model) throw new HttpError("Select a model from the Cloudflare-credit list.");
  // Routing is rechecked even when the catalog is cached.
  const route = await billing(env, group === "chat" ? config.gatewayId : profile.gatewayId);
  if (!creditRoute(model.provider, model.providers, route)) {
    throw new HttpError("This model cannot use Cloudflare credits with the current gateway settings.");
  }
  return model;
}

const modelPath = (id: string) => id.split("/").map(encodeURIComponent).join("/");

// OpenAI reasoning models take no temperature; others accept what their schema says.
async function temperatureSupport(env: DevEnv, model: any) {
  if (/^openai\/(?:gpt-[5-9]|o[1-9])/.test(model.id)) return null;
  const { result } = await cloudflare(env, `ai/catalog/models/${modelPath(model.id)}`);
  return temperatureRange(result.schema?.input ?? {}, model.apiFormat);
}

// Catalog schemas may describe Chat Completions and Responses requests as oneOf variants.
function temperatureRange(schema: any, apiFormat: string): { minimum: number; maximum: number } | null {
  const spec = schema.properties?.temperature;
  if (isObject(spec)) {
    const minimum = Math.max(0, spec.minimum ?? 0);
    const maximum = Math.min(2, spec.maximum ?? 2);
    return minimum < maximum ? { minimum, maximum } : null;
  }
  const field = apiFormat === "responses" ? "input" : "messages";
  const variant = (schema.oneOf ?? schema.anyOf ?? []).find((option: any) => field in (option.properties ?? {}));
  return variant ? temperatureRange(variant, apiFormat) : null;
}

// Only synchronous models that need nothing but a prompt qualify; keep the values each accepts.
async function imageSupport(env: DevEnv, model: any) {
  const { result } = await cloudflare(env, `ai/catalog/models/${modelPath(model.id)}`);
  const input = result.schema?.input ?? {};
  const required: string[] = input.required ?? [];
  if (required.some((field) => field !== "prompt") || !("image" in (result.schema?.output?.properties ?? {}))) return null;
  const properties = input.properties ?? {};
  const parameters = Object.fromEntries(
    ["aspect_ratio", "quality", "resolution", "response_format"]
      .filter((field) => field in properties)
      .map((field) => [field, { enum: properties[field].enum, default: properties[field].default, type: properties[field].type }]),
  );
  return { ...model, parameters };
}

// Bound concurrent schema lookups as the catalog grows.
async function mapLimited<T, R>(items: T[], map: (item: T) => Promise<R>, limit = 6): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
