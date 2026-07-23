import type { APIInteraction } from "discord-api-types/v10";

import type { Env } from "./env";
import { jsonResponse } from "./lib/http";
import { logger } from "./lib/logger";
import { verifyDiscordSignature } from "./lib/verify";
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

  ctx.waitUntil(dispatch(interaction, env, ctx));
  return jsonResponse({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_CHANNEL_MESSAGE });
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/interactions") {
      return handleInteraction(request, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // No-op for now; real sweep logic ported in a later task.
  },
} satisfies ExportedHandler<Env>;
