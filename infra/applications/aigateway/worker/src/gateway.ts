import { createApiTokenProviderClient, resolveSecret, type Identity, type PlatformClient } from "@platy/sdk";

import type { Env } from "./types";

export type ChatMessage = { role: string; content: string };

// OpenAI-compatible function tool definition, supplied by connectors.
export type ToolDefinition = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

// A tool invocation the model requested; arguments is a JSON string.
export type ToolCall = { id: string; name: string; arguments: string };

// Messages on the upstream wire: the proto-facing ChatMessage plus the
// assistant tool_calls / tool result shapes the tool loop appends internally.
export type UpstreamMessage = {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};

export type CompletionRequest = {
  model: string;
  messages: UpstreamMessage[];
  maxTokens?: number;
  temperature?: number;
  tools?: ToolDefinition[];
  stream: boolean;
};

export type Usage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

const compatBase = (env: Env): string =>
  `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.AIG_GATEWAY_ID}/compat`;

const upstreamClient = (env: Env, identity: Identity): PlatformClient =>
  createApiTokenProviderClient(
    {
      application: "aigateway",
      apiBaseUrl: compatBase(env),
      token: () => resolveSecret(env.CF_AIG_TOKEN),
      tokenHeader: "cf-aig-authorization",
      bearer: true,
    },
    identity,
  );

const compatUrl = (_env: Env): string => "/chat/completions";

export type CatalogModel = {
  id: string;
  provider: string;
  costIn: number;
  costOut: number;
};

let catalogCache: { models: CatalogModel[]; fetchedAt: number } | null = null;
const CATALOG_TTL_MS = 5 * 60_000;

// The gateway's model catalog (~2k provider-qualified models with pricing),
// fetched with the same injected authorization token and cached briefly in
// isolate memory.
export const listCatalogModels = async (env: Env, identity: Identity): Promise<CatalogModel[]> => {
  if (catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_TTL_MS) {
    return catalogCache.models;
  }
  const response = await upstreamClient(env, identity).fetch("/models");
  if (!response.ok) {
    throw new GatewayError(`model catalog returned ${response.status}`, response.status);
  }
  const body = (await response.json()) as {
    data?: Array<{ id?: string; owned_by?: string; cost_in?: number; cost_out?: number }>;
  };
  const models = (body.data ?? [])
    .filter((model) => typeof model.id === "string" && model.id.length > 0)
    .map((model) => ({
      id: model.id as string,
      provider: model.owned_by || (model.id as string).split("/")[0],
      costIn: model.cost_in ?? 0,
      costOut: model.cost_out ?? 0,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  catalogCache = { models, fetchedAt: Date.now() };
  return models;
};

const requestBody = (request: CompletionRequest): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    stream: request.stream,
  };
  if (request.maxTokens && request.maxTokens > 0) {
    body.max_tokens = request.maxTokens;
  }
  if (request.temperature !== undefined && request.temperature >= 0) {
    body.temperature = request.temperature;
  }
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools;
  }
  return body;
};

// The single outbound call. `cf-aig-authorization` carries the gateway auth
// token; unified billing means no provider key is sent — Cloudflare bills the
// account for paid providers, and `workers-ai/*` models stay on Workers AI
// postpaid billing.
const callGateway = async (
  env: Env,
  identity: Identity,
  request: CompletionRequest,
): Promise<Response> => {
  const response = await upstreamClient(env, identity).fetch(compatUrl(env), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody(request)),
  });
  if (!response.ok && !response.body) {
    throw new GatewayError(`ai gateway returned ${response.status}`, response.status);
  }
  return response;
};

type PayloadToolCall = {
  id?: string;
  function?: { name?: string; arguments?: string };
};

type CompletionPayload = {
  model?: string;
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: PayloadToolCall[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string } | string;
};

const toolCallsFrom = (raw: PayloadToolCall[] | undefined): ToolCall[] =>
  (raw ?? [])
    .filter((call) => call.id && call.function?.name)
    .map((call) => ({
      id: call.id as string,
      name: call.function?.name as string,
      arguments: call.function?.arguments ?? "{}",
    }));

const usageFrom = (usage: CompletionPayload["usage"]): Usage => ({
  promptTokens: usage?.prompt_tokens ?? 0,
  completionTokens: usage?.completion_tokens ?? 0,
  totalTokens: usage?.total_tokens ?? 0,
});

export type Completion = {
  content: string;
  model: string;
  finishReason: string;
  usage: Usage;
  toolCalls: ToolCall[];
};

export const complete = async (env: Env, identity: Identity, request: CompletionRequest): Promise<Completion> => {
  const response = await callGateway(env, identity, { ...request, stream: false });
  const payload = (await response.json()) as CompletionPayload;
  if (!response.ok) {
    const detail =
      typeof payload.error === "string" ? payload.error : payload.error?.message;
    throw new GatewayError(detail || `ai gateway returned ${response.status}`, response.status);
  }
  const choice = payload.choices?.[0];
  return {
    content: choice?.message?.content ?? "",
    model: payload.model ?? request.model,
    finishReason: choice?.finish_reason ?? "",
    usage: usageFrom(payload.usage),
    toolCalls: toolCallsFrom(choice?.message?.tool_calls),
  };
};

type StreamToolCallFragment = {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
};

type StreamPayload = {
  model?: string;
  choices?: Array<{
    delta?: { content?: string | null; tool_calls?: StreamToolCallFragment[] };
    finish_reason?: string | null;
  }>;
  usage?: CompletionPayload["usage"];
};

export type StreamEvent =
  | { kind: "delta"; delta: string }
  | {
    kind: "final";
    content: string;
    model: string;
    finishReason: string;
    usage: Usage;
    toolCalls: ToolCall[];
  };

// Parses the OpenAI-compatible SSE stream into deltas plus a synthesized final
// event carrying the assembled content and any usage the provider reported.
export async function* streamComplete(
  env: Env,
  identity: Identity,
  request: CompletionRequest,
): AsyncGenerator<StreamEvent> {
  const response = await callGateway(env, identity, { ...request, stream: true });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new GatewayError(text || `ai gateway returned ${response.status}`, response.status);
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let content = "";
  let model = request.model;
  let finishReason = "";
  let usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  // Tool calls stream as fragments keyed by index: the id and name arrive
  // once, the JSON arguments arrive as concatenated chunks.
  const pendingToolCalls = new Map<number, { id: string; name: string; args: string }>();
  const collectToolCalls = (fragments: StreamToolCallFragment[] | undefined) => {
    for (const fragment of fragments ?? []) {
      const index = fragment.index ?? 0;
      const pending = pendingToolCalls.get(index) ?? { id: "", name: "", args: "" };
      if (fragment.id) pending.id = fragment.id;
      if (fragment.function?.name) pending.name = fragment.function.name;
      if (fragment.function?.arguments) pending.args += fragment.function.arguments;
      pendingToolCalls.set(index, pending);
    }
  };
  const assembledToolCalls = (): ToolCall[] =>
    [...pendingToolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({ id: call.id, name: call.name, arguments: call.args || "{}" }))
      .filter((call) => call.id && call.name);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) {
            continue;
          }
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") {
            yield { kind: "final", content, model, finishReason, usage, toolCalls: assembledToolCalls() };
            return;
          }
          let parsed: StreamPayload;
          try {
            parsed = JSON.parse(data) as StreamPayload;
          } catch {
            continue;
          }
          if (parsed.model) {
            model = parsed.model;
          }
          if (parsed.usage) {
            usage = usageFrom(parsed.usage);
          }
          const choice = parsed.choices?.[0];
          if (choice?.finish_reason) {
            finishReason = choice.finish_reason;
          }
          collectToolCalls(choice?.delta?.tool_calls);
          const delta = choice?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            content += delta;
            yield { kind: "delta", delta };
          }
        }
      }
      if (done) {
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  yield { kind: "final", content, model, finishReason, usage, toolCalls: assembledToolCalls() };
}
