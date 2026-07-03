// The single seam between application workflows and the model backends. This
// module owns HOW a model call leaves the worker: the AI Gateway credential
// (CF_AIG_TOKEN via a boundary client), account/gateway URL construction,
// binding-vs-HTTP transport routing, and the per-transport request shape.
// Callers (packages/ai, the command processors) own WHAT to ask and how to
// interpret the raw response payloads — nothing outside this package touches
// CF_AIG_TOKEN, gateway.ai.cloudflare.com, or env.AI directly.
import { createBoundaryClient, type BoundaryFetch } from "../boundaries/outbound/boundary-client";
import type { Env } from "../contracts/types";
import { isRecord } from "../contracts/validation";

const AI_GATEWAY_TIMEOUT_MS = 120_000;

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type WebSearchContextSize = "low" | "medium" | "high";

// Free-form request attribution forwarded to the AI Gateway (cf-aig-metadata)
// so gateway logs can be joined back to application spend records.
export type InferenceMetadata = Record<string, string | number | boolean>;

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  gatewayId?: string | null;
  metadata?: InferenceMetadata;
};

export type WebSearchRequest = {
  model: string;
  input: string;
  instructions: string;
  maxOutputTokens: number;
  maxTurns: number;
  temperature: number;
  searchContextSize: WebSearchContextSize;
  gatewayId?: string | null;
  metadata?: InferenceMetadata;
};

export type RunOptions = {
  gatewayId?: string | null;
  metadata?: InferenceMetadata;
};

// Every method returns the raw provider payload (parsed JSON for gateway HTTP,
// whatever the Workers AI binding yields otherwise); response interpretation
// (text extraction, usage, sources) stays with the workflow layer.
export type InferenceClient = {
  // Chat completions. Partner models route through the AI Gateway's
  // OpenAI-compat endpoint when a gatewayId is configured; Workers AI models
  // (`@cf/...`, `workers-ai/...`) always run on the binding, gateway-wrapped
  // when a gatewayId is present.
  chat(request: ChatRequest): Promise<unknown>;
  // Web-search-tool completions. The two transports want different request
  // shapes (compat chat body with web_search_options vs a responses-style
  // binding input), so the shaping lives here with the routing.
  webSearch(request: WebSearchRequest): Promise<unknown>;
  // A raw Workers AI binding invocation (image/music generation and other
  // non-chat models), gateway-wrapped when a gatewayId is given.
  run(model: string, input: Record<string, unknown>, options?: RunOptions): Promise<unknown>;
};

const isWorkersAiModel = (model: string) => model.startsWith("@cf/");
const isGatewayWorkersAiModel = (model: string) => model.startsWith("workers-ai/");
const isBindingModel = (model: string) => isWorkersAiModel(model) || isGatewayWorkersAiModel(model);

// The model name a request actually runs as (the `workers-ai/` gateway prefix
// is routing, not identity). Exported so response handling can label results
// with the invoked model when the payload omits one.
export const toBindingModel = (model: string) =>
  isGatewayWorkersAiModel(model) ? model.slice("workers-ai/".length) : model;

const errorDetailFrom = (payload: unknown, fallback: string) => {
  if (!isRecord(payload)) {
    return fallback;
  }

  const error = payload.error;
  if (Array.isArray(error)) {
    return error
      .map((item) => isRecord(item) && typeof item.message === "string" ? item.message : null)
      .filter((message): message is string => Boolean(message))
      .join("; ") || fallback;
  }
  if (typeof error === "string") {
    return error;
  }
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  if (typeof payload.message === "string") {
    return payload.message;
  }
  if (typeof payload.description === "string") {
    return payload.description;
  }
  return fallback;
};

const lazy = <T>(create: () => T) => {
  let value: T | undefined;
  return () => (value ??= create());
};

const buildClient = (env: Env): InferenceClient => {
  const gatewayFetch: () => BoundaryFetch = lazy(() => {
    if (!env.CF_AIG_TOKEN) {
      throw new Error("CF_AIG_TOKEN is required for AI Gateway requests");
    }
    return createBoundaryClient({
      identity: "ai-gateway",
      trustZone: "egress-ai-gateway",
      credential: { header: "cf-aig-authorization", value: `Bearer ${env.CF_AIG_TOKEN}` },
      allowedHosts: ["gateway.ai.cloudflare.com"],
      defaultTimeoutMs: AI_GATEWAY_TIMEOUT_MS,
    });
  });

  const gatewayChatCompletions = async (
    gatewayId: string,
    body: Record<string, unknown>,
    metadata: InferenceMetadata | undefined,
    requiredDetail: string,
    failureLabel: string,
  ) => {
    if (!env.CF_ACCOUNT_ID) {
      throw new Error(`CF_ACCOUNT_ID is required for ${requiredDetail}`);
    }

    const response = await gatewayFetch()(
      `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${gatewayId}/compat/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(metadata ? { "cf-aig-metadata": JSON.stringify(metadata) } : {}),
        },
        body: JSON.stringify(body),
      },
    );

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = errorDetailFrom(payload, response.statusText);
      throw new Error(`${failureLabel} (${response.status}): ${detail}`);
    }

    return payload;
  };

  const runBinding = (model: string, input: Record<string, unknown>, options?: RunOptions) =>
    env.AI.run(
      model as never,
      input as never,
      options?.gatewayId
        ? ({ gateway: { id: options.gatewayId, metadata: options.metadata } } as never)
        : undefined,
    );

  return {
    chat: ({ model, messages, maxTokens, temperature, gatewayId, metadata }) =>
      gatewayId && !isBindingModel(model)
        ? gatewayChatCompletions(
          gatewayId,
          { model, messages, max_tokens: maxTokens, temperature },
          metadata,
          "partner AI Gateway models",
          "AI Gateway request failed",
        )
        : runBinding(
          toBindingModel(model),
          { messages, max_tokens: maxTokens, temperature },
          gatewayId ? { gatewayId, metadata } : undefined,
        ),

    webSearch: ({
      model,
      input,
      instructions,
      maxOutputTokens,
      maxTurns,
      temperature,
      searchContextSize,
      gatewayId,
      metadata,
    }) =>
      gatewayId
        ? gatewayChatCompletions(
          gatewayId,
          {
            model,
            messages: [
              { role: "system", content: instructions },
              { role: "user", content: input },
            ],
            max_tokens: maxOutputTokens,
            web_search_options: { search_context_size: searchContextSize },
          },
          metadata,
          "AI Gateway web-search models",
          "AI Gateway web-search request failed",
        )
        : runBinding(model, {
          input,
          instructions,
          max_output_tokens: maxOutputTokens,
          max_turns: maxTurns,
          temperature,
          tools: [{ type: "web_search", search_context_size: searchContextSize }],
        }),

    run: runBinding,
  };
};

const clientsByEnv = new WeakMap<Env, InferenceClient>();

export const inferenceClient = (env: Env): InferenceClient => {
  const cached = clientsByEnv.get(env);
  if (cached) {
    return cached;
  }
  const client = buildClient(env);
  clientsByEnv.set(env, client);
  return client;
};
