// Worker entrypoint: Discord interactions, operator gateway controls, and the cron watchdog.
import { dispatch, isSlow } from "./commands.ts";
import { reply } from "./discord.ts";
import { DiscordGateway, gateway } from "./gateway.ts";
import { InteractionResponseTypes, InteractionTypes, readInteraction } from "./lib/discord/interactions.ts";
import { truncate } from "./lib/discord/rest.ts";

// Discord drops an interaction without a response within 3 s; leave room for the trip back.
const INLINE_MS = 2000;

export { DiscordGateway };

export interface Env {
  DB: D1Database;
  AI: Ai;
  DISCORD_GATEWAY: DurableObjectNamespace<DiscordGateway>;
  DISCORD_APPLICATION_ID: string;
  ALLOWED_GUILD_IDS: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  GATEWAY_CONTROL_TOKEN: string;
}

const controls: Record<string, (stub: DurableObjectStub<DiscordGateway>) => Promise<unknown>> = {
  "POST /gateway/start": (stub) => stub.start(),
  "POST /gateway/stop": (stub) => stub.stop(),
  "GET /gateway/health": (stub) => stub.health(),
};

export default {
  async fetch(request, env, ctx) {
    const route = `${request.method} ${new URL(request.url).pathname}`;
    if (route === "POST /interactions") return interactions(request, env, ctx);
    const control = controls[route];
    if (!control) return new Response(null, { status: 404 });
    const denied = authorize(request.headers.get("authorization"), env.GATEWAY_CONTROL_TOKEN);
    if (denied) {
      console.warn(`gateway_control_denied status=${denied}`);
      return new Response(null, { status: denied });
    }
    return Response.json(await control(gateway(env)));
  },

  async scheduled(_controller, env) {
    try {
      await gateway(env).ensureConnected();
    } catch {
      console.error("gateway_ensure_connected_failed");
    }
  },
} satisfies ExportedHandler<Env>;

async function interactions(request: Request, env: Env, ctx: ExecutionContext) {
  const interaction = await readInteraction(request, env.DISCORD_PUBLIC_KEY);
  if (interaction === 401) console.warn("interaction_signature_denied");
  if (interaction === 400) console.warn("interaction_body_unparseable");
  if (typeof interaction === "number") return new Response(null, { status: interaction });
  switch (interaction.type) {
    case InteractionTypes.PING:
      return Response.json({ type: InteractionResponseTypes.PONG });
    case InteractionTypes.APPLICATION_COMMAND:
      if (!isSlow(interaction)) return answer(env, interaction, ctx);
      // Defer now and run the command in the Durable Object, which can outlive this request's
      // 30 s waitUntil window; if the handoff fails, run it here instead.
      ctx.waitUntil(
        gateway(env)
          .runCommand(interaction)
          .catch(() => {
            console.error("command_handoff_failed");
            return dispatch(env, interaction);
          }),
      );
      return Response.json({ type: InteractionResponseTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });
    default:
      return new Response(null, { status: 400 });
  }
}

/**
 * Run a command here and send its first reply as the interaction response, which skips the
 * "thinking" state and a webhook edit. A command still running near Discord's 3 s deadline
 * defers instead, and its reply then edits the deferred response.
 */
function answer(env: Env, interaction: any, ctx: ExecutionContext) {
  return new Promise<Response>((resolve) => {
    let open = true;
    const respond = (body: object) => {
      open = false;
      clearTimeout(timer);
      resolve(Response.json(body));
    };
    const deferred = { type: InteractionResponseTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE };
    const timer = setTimeout(() => respond(deferred), INLINE_MS);
    const run = dispatch(env, interaction, async (content, options = {}) => {
      if (!open || options.files?.length) return reply(interaction, content, options);
      const data = { content: truncate(content, 2000), allowed_mentions: { parse: [], users: options.users } };
      respond({ type: InteractionResponseTypes.CHANNEL_MESSAGE_WITH_SOURCE, data });
      return true;
    });
    ctx.waitUntil(run.finally(() => open && respond(deferred)));
  });
}

// Operator routes take `Authorization: Bearer <GATEWAY_CONTROL_TOKEN>` and fail closed:
// missing credentials are 401 and a wrong token is 403.
function authorize(authorization: string | null, token: string) {
  if (!token || !authorization) return 401;
  const [scheme, ...rest] = authorization.split(" ");
  const presented = rest.join(" ");
  if (scheme.toLowerCase() !== "bearer" || !presented) return 401;
  const encoder = new TextEncoder();
  const [given, expected] = [encoder.encode(presented), encoder.encode(token)];
  return given.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(given, expected)
    ? null
    : 403;
}
