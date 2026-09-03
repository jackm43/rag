// The model picker's catalog. The AI Gateway's Unified API exposes the models it
// can route (with per-token cost) at compat/models — the same endpoint family the
// bot's chat calls use, so anything listed is callable as `provider/model`.
import { isRecord } from "../src/lib/contracts";
import type { DevEnv } from "./env";

// How a request for the model gets its provider credentials on this gateway:
// "included" — billed through the gateway (Workers AI, or a provider covered by
// AI Gateway Unified Billing); "byok" — a provider key is stored on the gateway
// under the `default` alias; "key-required" — neither, so the request would
// reach the provider with no credentials and fail until a key is stored.
export type ModelAccess = "included" | "byok" | "key-required";

export type CatalogModel = {
  id: string;
  provider: string;
  access: ModelAccess;
  // USD per token, when the gateway reports it.
  costIn: number | null;
  costOut: number | null;
  // "chat" when the id looks like a text/chat model; "other" for media, audio,
  // embeddings, batch aliases and the like (still selectable, just hidden by
  // default).
  kind: "chat" | "other";
};

export type ModelCatalog = {
  source: "gateway" | "fallback";
  fetchedAt: string;
  error?: string;
  models: CatalogModel[];
  // Providers covered without a key, and the BYOK aliases stored per provider.
  unifiedBillingProviders: string[];
  byokProviders: Record<string, string[]>;
  byokError?: string;
};

// Providers AI Gateway bills through the Cloudflare account (Unified Billing,
// per developers.cloudflare.com/ai-gateway/features/unified-billing) — a request
// with no provider key still succeeds for these. Coverage is per provider, not
// per model (e.g. grok-4.3 works, grok-4.6 does not, at the time of writing), so
// the UI also learns from "no credentials" rejections at run time.
const UNIFIED_BILLING_PROVIDERS = ["openai", "anthropic", "google-ai-studio", "google-vertex-ai", "grok", "groq"];
const ACCOUNT_BILLED_PROVIDERS = new Set(["workers-ai"]);
const BYOK_SECRET_COMMENT = "Managed by AI Gateway";
const CF_API = "https://api.cloudflare.com/client/v4";

const CATALOG_TTL_MS = 10 * 60_000;
const CATALOG_TIMEOUT_MS = 20_000;

const NON_CHAT_PATTERN =
  /(image|video|imagine|tts|stt|whisper|embed|rerank|transcri|speech|audio|sora|dall-e|imagen|flux|neurons|moderation|:batch$|realtime|ocr|music|voice|sound|upscal|inpaint|lipsync|avatar|clip\b|guard|classif|safety|veo|lyria|omni-moderation|translat|detect|segment|resnet|uform|bge|m2m|nsfw|dreamshaper|stable-diffusion|kling|hailuo|seedance|seedream|ideogram|recraft|krea|runway|pixverse|vidu|elevenlabs|assemblyai|inworld|lightricks|minimax\/(?!minimax-m|minimax-text)|bytedance\/(?!doubao)|pruna|fal\/|replicate\/(?!.*(?:llama|qwen|deepseek|mistral)))/i;

const FALLBACK_MODELS: Array<Pick<CatalogModel, "id" | "provider">> = [
  { id: "grok/grok-4.3", provider: "grok" },
  { id: "grok/grok-4.6", provider: "grok" },
  { id: "grok/grok-4-fast", provider: "grok" },
  { id: "openai/gpt-5.2", provider: "openai" },
  { id: "openai/gpt-4o", provider: "openai" },
  { id: "openai/gpt-4o-search-preview", provider: "openai" },
  { id: "anthropic/claude-fable-5.1", provider: "anthropic" },
  { id: "anthropic/claude-sonnet-5", provider: "anthropic" },
  { id: "google-ai-studio/gemini-3.8-flash", provider: "google-ai-studio" },
  { id: "deepseek/deepseek-chat", provider: "deepseek" },
  { id: "groq/llama-3.3-70b-versatile", provider: "groq" },
  { id: "mistral/mistral-large-latest", provider: "mistral" },
  { id: "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast", provider: "workers-ai" },
  { id: "workers-ai/@cf/openai/gpt-oss-120b", provider: "workers-ai" },
];

const numberOrNull = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

const classify = (id: string): CatalogModel["kind"] => (NON_CHAT_PATTERN.test(id) ? "other" : "chat");

const accessFor = (provider: string, byok: Record<string, string[]>): ModelAccess => {
  if (ACCOUNT_BILLED_PROVIDERS.has(provider)) {
    return "included";
  }
  if (byok[provider]?.includes("default")) {
    return "byok";
  }
  return UNIFIED_BILLING_PROVIDERS.includes(provider) ? "included" : "key-required";
};

// BYOK keys are AI Gateway-managed secrets in the account's Secrets Store, named
// `{gateway}_{provider}_{alias}`. Lists them for this gateway; needs
// CLOUDFLARE_API_TOKEN (Secrets Store read), so the result is best-effort.
const fetchByokProviders = async (env: DevEnv): Promise<{ byok: Record<string, string[]>; error?: string }> => {
  const byok: Record<string, string[]> = {};
  if (!env.CLOUDFLARE_API_TOKEN) {
    return { byok, error: "CLOUDFLARE_API_TOKEN not set; stored provider keys unknown" };
  }
  const gatewayId = env.CF_AIG_GATEWAY_ID || "platy";
  const headers = { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };
  try {
    const gatewayResponse = await fetch(`${CF_API}/accounts/${env.CF_ACCOUNT_ID}/ai-gateway/gateways/${gatewayId}`, {
      headers,
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
    const gateway: unknown = await gatewayResponse.json().catch(() => null);
    const storeId = isRecord(gateway) && isRecord(gateway.result) && typeof gateway.result.store_id === "string"
      ? gateway.result.store_id
      : null;
    if (!storeId) {
      return { byok, error: `gateway ${gatewayId} has no secrets store (${gatewayResponse.status})` };
    }
    for (let page = 1; page <= 10; page += 1) {
      const response = await fetch(
        `${CF_API}/accounts/${env.CF_ACCOUNT_ID}/secrets_store/stores/${storeId}/secrets?per_page=100&page=${page}`,
        { headers, signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || !isRecord(payload) || !Array.isArray(payload.result)) {
        return { byok, error: `secrets store list failed (${response.status})` };
      }
      for (const secret of payload.result) {
        if (!isRecord(secret) || secret.comment !== BYOK_SECRET_COMMENT || typeof secret.name !== "string") {
          continue;
        }
        const prefix = `${gatewayId}_`;
        if (!secret.name.startsWith(prefix)) {
          continue;
        }
        const rest = secret.name.slice(prefix.length);
        const split = rest.lastIndexOf("_");
        if (split <= 0) {
          continue;
        }
        const provider = rest.slice(0, split);
        (byok[provider] ??= []).push(rest.slice(split + 1));
      }
      if (payload.result.length < 100) {
        break;
      }
    }
    return { byok };
  } catch (error) {
    return { byok, error: error instanceof Error ? error.message : String(error) };
  }
};

const fallbackCatalog = (error: string): ModelCatalog => ({
  source: "fallback",
  fetchedAt: new Date().toISOString(),
  error,
  models: FALLBACK_MODELS.map((model) => ({ ...model, access: "included", costIn: null, costOut: null, kind: "chat" })),
  unifiedBillingProviders: UNIFIED_BILLING_PROVIDERS,
  byokProviders: {},
});

const fetchGatewayCatalog = async (env: DevEnv): Promise<ModelCatalog> => {
  const byokPromise = fetchByokProviders(env);
  const gatewayId = env.CF_AIG_GATEWAY_ID || "platy";
  const response = await fetch(
    `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${gatewayId}/compat/models`,
    {
      headers: { "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}` },
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    },
  );
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error(`compat/models returned ${response.status}`);
  }

  const { byok, error: byokError } = await byokPromise;
  const models: CatalogModel[] = [];
  for (const entry of payload.data) {
    if (!isRecord(entry) || typeof entry.id !== "string") {
      continue;
    }
    const provider = typeof entry.owned_by === "string" ? entry.owned_by : entry.id.split("/")[0];
    models.push({
      id: entry.id,
      provider,
      access: accessFor(provider, byok),
      costIn: numberOrNull(entry.cost_in),
      costOut: numberOrNull(entry.cost_out),
      kind: classify(entry.id),
    });
  }
  models.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
  return {
    source: "gateway",
    fetchedAt: new Date().toISOString(),
    models,
    unifiedBillingProviders: UNIFIED_BILLING_PROVIDERS,
    byokProviders: byok,
    ...(byokError ? { byokError } : {}),
  };
};

let cached: { catalog: ModelCatalog; expiresAt: number } | null = null;

export const loadModelCatalog = async (env: DevEnv, force = false): Promise<ModelCatalog> => {
  if (!force && cached && cached.expiresAt > Date.now()) {
    return cached.catalog;
  }
  let catalog: ModelCatalog;
  try {
    catalog = await fetchGatewayCatalog(env);
  } catch (error) {
    catalog = fallbackCatalog(error instanceof Error ? error.message : String(error));
  }
  cached = { catalog, expiresAt: Date.now() + (catalog.source === "gateway" ? CATALOG_TTL_MS : 30_000) };
  return catalog;
};
