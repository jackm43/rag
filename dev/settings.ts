// Dev UI settings: drafts, reviewed saves to local or live D1, and the Cloudflare-credit model catalog.
import { rejectsSampling } from "../src/lib/ai.ts";
import { isObject } from "../src/lib/json.ts";
import { parseSettings, SETTINGS_SQL, SettingsError, type Settings } from "../src/settings.ts";
import type { DevEnv } from "./index.ts";

export type Page = "chat" | "bicture";

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

const catalogUnavailable = () => new HttpError("Cannot verify Cloudflare-credit access. Retry the model list.", 503);

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

const activeProfile = (settings: Settings) => settings.image.profiles[settings.image.activeProfile];
const editable = (settings: Settings) => ({ chat: settings.chat, image: settings.image });

/**
 * The settings a page's draft resolves to. The UI sends the whole `{ chat, image }` draft; the
 * fields that depend on the model (chat API format and temperature support, image parameters)
 * are taken from the live catalog for that page.
 */
export async function resolveDraft(env: DevEnv, current: Settings, raw: unknown, page: unknown): Promise<Settings> {
  if (raw === undefined) return current;
  if (!isObject(raw) || (page !== "chat" && page !== "bicture")) throw new HttpError("Invalid settings draft.");
  let draft: Settings;
  try {
    draft = parseSettings({ ...current, chat: raw.chat, image: raw.image });
  } catch (error) {
    if (error instanceof SettingsError) throw new HttpError(error.message);
    throw error;
  }
  // Reasoning support is model-specific; do not carry it to another model.
  if (draft.chat.model !== current.chat.model) delete draft.chat.reasoningEffort;
  if (page === "bicture") {
    const profile = activeProfile(draft);
    profile.parameters = imageParameters(await checkModel(env, draft, "image"), profile.parameters);
    return draft;
  }
  const model = await checkModel(env, draft, "chat");
  const range = model.temperature;
  if (range && !(draft.chat.temperature >= range.minimum && draft.chat.temperature <= range.maximum)) {
    throw new HttpError(`Choose a temperature from ${range.minimum} to ${range.maximum} for this model.`);
  }
  draft.chat.apiFormat = model.apiFormat;
  draft.chat.temperatureSupported = Boolean(range);
  return draft;
}

/** A draft as the settings row a simulation reads; unsaved changes get a `+draft-` revision. */
export async function draftRow(draft: Settings, current: Settings) {
  const checksum = await sha256(editable(draft));
  const revision = checksum === (await sha256(editable(current))) ? current.revision : `${current.revision}+draft-${checksum.slice(0, 12)}`;
  return { revision, document: JSON.stringify({ ...draft, revision }) };
}

// Every leaf setting that differs, by dotted path.
function changes(before: Settings, after: Settings) {
  const flatten = (value: unknown, path: string): [string, unknown][] =>
    isObject(value) ? Object.entries(value).flatMap(([key, child]) => flatten(child, path ? `${path}.${key}` : key)) : [[path, value]];
  const [saved, draft] = [new Map(flatten(editable(before), "")), new Map(flatten(editable(after), ""))];
  return [...new Set([...saved.keys(), ...draft.keys()])]
    .filter((setting) => canonical(saved.get(setting)) !== canonical(draft.get(setting)))
    .map((setting) => ({ setting, before: saved.get(setting) ?? null, after: draft.get(setting) ?? null }));
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

  // The local sandbox is the dev database; LIVE_DB is a remote binding to the live bot's database.
  async query(sql: string, params: unknown[] = []) {
    try {
      return await (this.target === "live" ? this.env.LIVE_DB : this.env.DB).prepare(sql).bind(...params).all<any>();
    } catch {
      throw new HttpError("D1 could not read or save settings. Check D1 access and migrations; reload before retrying.", 503);
    }
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
    let settings: Settings;
    try {
      settings = parseSettings(JSON.parse(row.document));
    } catch {
      throw new HttpError("Saved settings are invalid. Apply the D1 migrations for this destination.", 409);
    }
    if (settings.revision !== row.revision) throw new HttpError("Saved settings revision is invalid.", 409);
    return { target: this.target, revision: settings.revision, settings };
  }

  async preview(body: any) {
    const { current, draft, changes } = await this.prepare(body);
    return { changes, reviewId: await sha256([this.target, current.revision, editable(draft)]) };
  }

  // One save at a time here; the conditional write also rejects saves made elsewhere since loading.
  save(body: any) {
    const result = saving.then(async () => {
      const { current, draft, changes } = await this.prepare(body);
      if (body.reviewId !== (await sha256([this.target, current.revision, editable(draft)]))) {
        throw new HttpError("Review these exact settings before saving.", 409);
      }
      if (!changes.length) throw new HttpError("There are no changes to save.");
      const revision = crypto.randomUUID().replaceAll("-", "");
      const settings = parseSettings({ ...draft, revision, updatedAt: new Date().toISOString() });
      const { meta } = await this.query(SAVE_SQL, [revision, JSON.stringify(settings), current.revision]);
      if (meta?.changes !== 1) throw new HttpError("Settings changed during your save. Reload and review again.", 409);
      return { target: this.target, revision, settings };
    });
    saving = result.catch(() => {});
    return result;
  }

  private async prepare(body: any) {
    const { settings: current } = await this.read();
    if (body.baseRevision !== current.revision) {
      throw new HttpError("Settings changed since you loaded them. Reload and review again.", 409);
    }
    if (body.page !== "chat" && body.page !== "bicture") throw new HttpError("This command has no editable AI settings.");
    const draft = await resolveDraft(this.env, current, body.settings, body.page);
    const other = body.page === "chat" ? "image" : "chat";
    if (canonical(draft[other]) !== canonical(current[other])) throw new HttpError("Review settings for one page at a time.");
    return { current, draft, changes: changes(current, draft) };
  }
}

// Send only parameters the model's schema accepts, with values it allows.
function imageParameters(model: any, saved: Record<string, string>) {
  const parameters: Record<string, string> = {};
  for (const [field, spec] of Object.entries<any>(model.parameters)) {
    const value = !spec.enum || spec.enum.includes(saved[field]) ? saved[field] : spec.default;
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
export async function loadCatalog(env: DevEnv, settings: Settings, refresh = false) {
  const gateways = [settings.chat.gatewayId, activeProfile(settings).gatewayId];
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
async function checkModel(env: DevEnv, settings: Settings, group: "chat" | "image") {
  const catalog = await loadCatalog(env, settings);
  const profile = activeProfile(settings);
  const selected = group === "chat" ? settings.chat.model : profile.model;
  const model = catalog[group].find((entry) => entry.id === selected);
  if (!model) throw new HttpError("Select a model from the Cloudflare-credit list.");
  // Routing is rechecked even when the catalog is cached.
  const route = await billing(env, group === "chat" ? settings.chat.gatewayId : profile.gatewayId);
  if (!creditRoute(model.provider, model.providers, route)) {
    throw new HttpError("This model cannot use Cloudflare credits with the current gateway settings.");
  }
  return model;
}

const modelPath = (id: string) => id.split("/").map(encodeURIComponent).join("/");

// OpenAI reasoning models take no temperature; others accept what their schema says.
async function temperatureSupport(env: DevEnv, model: any) {
  if (rejectsSampling(model.id)) return null;
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
