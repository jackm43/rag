import { createLeaderboardServiceClient } from "../../../ragbot/service";
import {
  errorMessage,
  logger,
  serviceConnection,
  type Identity,
  type SpanContext,
  type Tracer,
} from "../../../../sdk/ts/src";
import type { ToolCall, ToolDefinition, UpstreamMessage } from "./gateway";
import type { Env } from "./types";

// Connectors expose other trust zone applications to the chat as tools
// (MCP-style): each tool maps to an authenticated RPC on the target
// application, called with the *user's* chained identity — subject = the
// caller, actor = this worker's service credential, audience = the target —
// so the target authorizes the real user and audit records the chain.

type ToolHandler = (identity: Identity, args: Record<string, unknown>) => Promise<unknown>;

export type Connectors = {
  tools: ToolDefinition[];
  invoke(identity: Identity, call: ToolCall, parent: SpanContext | null): Promise<string>;
};

const RAGBOT_SCOPE = "ragbot/LeaderboardService.ListTotals";

const ragbotConnection = (env: Env) =>
  serviceConnection(env, {
    endpoint: env.RAGBOT_ENDPOINT,
    binding: env.RAGBOT,
    scopes: [RAGBOT_SCOPE],
  });

const boundedInt = (value: unknown, fallback: number, max: number): number => {
  const parsed = typeof value === "number" ? Math.trunc(value) : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
};

export const buildConnectors = (env: Env, tracer: Tracer): Connectors => {
  const tools: ToolDefinition[] = [];
  const handlers = new Map<string, ToolHandler>();

  const ragbot = ragbotConnection(env);
  if (ragbot) {
    tools.push({
      type: "function",
      function: {
        name: "ragbot_leaderboard",
        description:
          "Fetch the current rag leaderboard from the ragbot Discord application: per-user rag totals, highest first.",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "integer", description: "Maximum number of entries to return (default 10, max 50)" },
          },
          required: [],
        },
      },
    });
    handlers.set("ragbot_leaderboard", (identity, args) =>
      createLeaderboardServiceClient(ragbot, identity).listTotals({
        limit: boundedInt(args.limit, 10, 50),
      }),
    );
  }

  const invoke = async (
    identity: Identity,
    call: ToolCall,
    parent: SpanContext | null,
  ): Promise<string> => {
    const handler = handlers.get(call.name);
    if (!handler) {
      throw new Error(`unknown tool ${call.name}`);
    }
    let args: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(call.arguments || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // Tolerate malformed model output; the tool sees no arguments.
    }
    return tracer.span(
      `connector ${call.name}`,
      {
        kind: "client",
        // Prefer the inbound traceparent (survives streaming generators where
        // the async-local context is lost); fall back to the active span.
        ...(parent ? { parent } : {}),
        attributes: { actor: identity.email ?? identity.subject, tool: call.name },
      },
      // Generated pb responses carry int64 fields as BigInt and a $typeName
      // marker; serialize tool results model-readably.
      async () =>
        JSON.stringify(await handler(identity, args), (key, value: unknown) =>
          key === "$typeName" ? undefined : typeof value === "bigint" ? Number(value) : value,
        ),
    );
  };

  return { tools, invoke };
};

// runToolCalls executes the model's requested tool calls and returns the
// upstream messages for the next round: failures become structured error
// results so the model can explain instead of the request hard-failing.
export const runToolCalls = async (
  connectors: Connectors,
  identity: Identity,
  calls: ToolCall[],
  parent: SpanContext | null,
): Promise<UpstreamMessage[]> => {
  const results: UpstreamMessage[] = [];
  for (const call of calls) {
    let content: string;
    try {
      content = await connectors.invoke(identity, call, parent);
    } catch (error) {
      logger.warn("connector_tool_failed", {
        tool: call.name,
        actor: identity.email ?? identity.subject,
        error: errorMessage(error),
      });
      content = JSON.stringify({ error: errorMessage(error) });
    }
    results.push({ role: "tool", tool_call_id: call.id, content });
  }
  return results;
};

// assistantToolCallMessage echoes the model's tool request back into the
// conversation, as the OpenAI-compatible protocol requires before results.
export const assistantToolCallMessage = (content: string, calls: ToolCall[]): UpstreamMessage => ({
  role: "assistant",
  content: content || null,
  tool_calls: calls.map((call) => ({
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: call.arguments },
  })),
});
