// Worker entrypoint: Discord interactions, operator gateway controls, and the cron watchdog.
import { dispatch } from "./commands.ts";
import { DiscordGateway, gateway } from "./gateway.ts";

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
  // Discord signs the timestamp plus the exact body bytes: verify before parsing anything.
  const body = await request.arrayBuffer();
  if (!(await verified(request.headers, body, env.DISCORD_PUBLIC_KEY))) {
    console.warn("interaction_signature_denied");
    return new Response(null, { status: 401 });
  }
  let interaction: any;
  try {
    interaction = JSON.parse(new TextDecoder().decode(body));
  } catch {
    console.warn("interaction_body_unparseable");
    return new Response(null, { status: 400 });
  }
  switch (interaction.type) {
    case 1: // PING
      return Response.json({ type: 1 });
    case 2: // APPLICATION_COMMAND: defer now, then edit the reply when the command finishes.
      ctx.waitUntil(dispatch(env, interaction));
      return Response.json({ type: 5 });
    default:
      return new Response(null, { status: 400 });
  }
}

async function verified(headers: Headers, body: ArrayBuffer, publicKey: string) {
  const signature = headers.get("x-signature-ed25519");
  const timestamp = headers.get("x-signature-timestamp");
  if (!publicKey || !signature || !timestamp || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hex(publicKey), "Ed25519", false, ["verify"]);
    const message = await new Blob([timestamp, body]).arrayBuffer();
    return await crypto.subtle.verify("Ed25519", key, hex(signature), message);
  } catch {
    return false;
  }
}

function hex(value: string) {
  if (!/^(?:[\da-f]{2})+$/i.test(value)) throw new Error("invalid hex");
  return Uint8Array.from(value.match(/../g)!, (byte) => parseInt(byte, 16));
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
