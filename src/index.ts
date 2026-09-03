import type { APIInteraction } from "discord-api-types/v10";

import type { Env } from "./env";
import { reconcileAiSpend } from "./lib/ai/reconcile";
import { pruneAiRequestLog } from "./lib/db/limits";
import { jsonResponse } from "./lib/http";
import { errorMessage, logger } from "./lib/logger";
import { verifyDiscordSignature } from "./lib/verify";
import {
  ensureGatewayConnected,
  getGatewayHealth,
  startGateway,
  stopGateway,
} from "./structs/gateway";
import { dispatch } from "./structs/registry";

export { DiscordGateway } from "./structs/gateway";

// discord-api-types v10 ships InteractionType/InteractionResponseType as
// runtime enums, but esbuild's CJS interop for that package resolves them to
// undefined under the Workers bundler (verified: the named/namespace/default
// exports all read back undefined here despite Object.keys listing them —
// a circular-require ordering issue in the bundled output, not our usage).
// APIInteraction (types only, erased at build time) is unaffected, so we keep
// using it for typing and hardcode the two protocol-stable numeric values
// this endpoint needs.
const INTERACTION_TYPE_PING = 1;
const INTERACTION_TYPE_APPLICATION_COMMAND = 2;
const INTERACTION_RESPONSE_TYPE_PONG = 1;
const INTERACTION_RESPONSE_TYPE_DEFERRED_CHANNEL_MESSAGE = 5;

const handleInteraction = async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
  const rawBody = await request.text();

  if (!verifyDiscordSignature(env.DISCORD_PUBLIC_KEY, request, rawBody)) {
    return new Response("Bad request signature", { status: 401 });
  }

  let interaction: APIInteraction;
  try {
    interaction = JSON.parse(rawBody) as APIInteraction;
  } catch (error) {
    logger.error("interaction_body_unparseable", { error: String(error) });
    return new Response("Bad request", { status: 400 });
  }

  if (interaction.type === INTERACTION_TYPE_PING) {
    return jsonResponse({ type: INTERACTION_RESPONSE_TYPE_PONG });
  }

  // Only slash commands are registered. A deferred-message ack is not a valid
  // response to autocomplete/component/modal interactions, so reject those
  // outright instead of acking publicly and then editing in an error.
  if (interaction.type !== INTERACTION_TYPE_APPLICATION_COMMAND) {
    return new Response("Unsupported interaction type", { status: 400 });
  }

  ctx.waitUntil(dispatch(interaction, env, ctx));
  return jsonResponse({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_CHANNEL_MESSAGE });
};

// Constant-time comparison so a wrong control token cannot be probed byte by byte.
const tokensMatch = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
};

// Operator control routes are guarded by the GATEWAY_CONTROL_TOKEN bearer;
// holding the token IS the authorization. A missing/unconfigured credential is
// 401 (unauthenticated); a present-but-wrong token is 403 (forbidden).
const authorizeControl = (request: Request, env: Env): Response | null => {
  const controlToken = env.GATEWAY_CONTROL_TOKEN;
  const authorization = request.headers.get("authorization");
  if (!controlToken || authorization === null) {
    return new Response("Unauthorized", { status: 401 });
  }

  const [scheme, ...rest] = authorization.split(" ");
  const presented = rest.join(" ");
  if (scheme.toLowerCase() !== "bearer" || !presented) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!tokensMatch(presented, controlToken)) {
    return new Response("Forbidden", { status: 403 });
  }
  return null;
};

// POST /gateway/start, POST /gateway/stop, GET /gateway/health — the operator
// control surface ported from apps/gateway/src/router.ts, collapsed into the
// single worker. Returns null for non-control paths so the caller can fall
// through to the interactions route and the 404.
const handleControlRoute = async (
  request: Request,
  env: Env,
  method: string,
  pathname: string,
): Promise<Response | null> => {
  const route =
    method === "POST" && pathname === "/gateway/start"
      ? startGateway
      : method === "POST" && pathname === "/gateway/stop"
        ? stopGateway
        : method === "GET" && pathname === "/gateway/health"
          ? getGatewayHealth
          : null;
  if (!route) {
    return null;
  }

  const denied = authorizeControl(request, env);
  if (denied) {
    return denied;
  }
  return Response.json(await route(env));
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/interactions") {
      return handleInteraction(request, env, ctx);
    }

    const control = await handleControlRoute(request, env, request.method, url.pathname);
    if (control) {
      return control;
    }

    return new Response("Not found", { status: 404 });
  },

  // Cron trigger: keep the gateway websocket up (self-heals after a deploy and
  // is a no-op once an operator has stopped it) and run one spend reconciliation
  // sweep so /ragspend* and the budget guard stay accurate without queues.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      ensureGatewayConnected(env).catch((error) => {
        logger.error("gateway_ensure_connected_failed", { error: errorMessage(error) });
      }),
    );
    ctx.waitUntil(
      reconcileAiSpend(env).catch((error) => {
        logger.error("ai_spend_reconcile_failed", { error: errorMessage(error) });
      }),
    );
    ctx.waitUntil(pruneAiRequestLog(env));
  },
} satisfies ExportedHandler<Env>;
