import { ensureRegistered, registryEntities } from "@rag/service-kit";
import { authorize } from "@rag/authz/authorize";
import type { DiscordInteractionPrincipal } from "../../../../../lib/ingress/discord-interaction";
import { routeInteraction } from "../../../../../lib/domain/commands/router";
import {
  extractBotMentionPrompt,
  handleGatewayMessageCreate,
} from "../../../../../lib/domain/mention";
import type { Env } from "../../../../../contracts";
import {
  ApplicationMiddleware,
  DevProxy,
  DiscordGateway,
  GATEWAY_MANIFEST,
  ensureGatewayConnected,
  getGatewayHealth,
  startGateway,
  stopGateway,
} from "../../../service_server/src";
import { publicJwks } from "@rag/service-kit/identity";
import { OPENAPI } from "./openapi";
import { createGatewayRouter } from "./router";

export { ApplicationMiddleware, DevProxy, DiscordGateway, extractBotMentionPrompt, handleGatewayMessageCreate };

// The bearer-token guard (wired by the router from the spec's security scheme)
// authenticates the gateway-control application; Cedar decides what that
// control-plane application may do with the gateway.
const gatewayControlForbidden = async (env: Env, action: string): Promise<Response | null> =>
  authorize(
    {
      principal: { type: "Application", id: "gateway-control" },
      action,
      resource: { type: "Gateway", id: "control" },
    },
    await registryEntities(env),
  ).allowed
    ? null
    : new Response("Forbidden", { status: 403 });

// Handlers keyed by generated OpenAPI operationId; the router runs each
// operation's ingress guard first and passes its grant through.
const router = createGatewayRouter({
  openApiJson: () => Response.json(OPENAPI),
  // The gateway is not an OAuth authorization server or OpenID provider — it
  // has no /oauth/authorize or /oauth/token endpoint. These two documents
  // exist purely for key discovery, so relying parties can resolve
  // `jwks_uri` and verify the Ed25519 (EdDSA) service-identity tokens minted
  // by ragbot workers (see packages/service-kit/identity/token.ts). They intentionally
  // omit authorization_endpoint/token_endpoint and the grant/response-type
  // fields that would advertise a flow that doesn't exist.
  oauthAuthorizationServerMetadata: (request) => {
    const origin = new URL(request.url).origin;
    return Response.json({
      issuer: origin,
      jwks_uri: `${origin}/.well-known/jwks.json`,
    });
  },
  openidConfiguration: (request) => {
    const origin = new URL(request.url).origin;
    return Response.json({
      issuer: origin,
      jwks_uri: `${origin}/.well-known/jwks.json`,
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["EdDSA"],
    });
  },
  jwks: () =>
    Response.json(publicJwks(), {
      headers: { "Cache-Control": "public, max-age=3600" },
    }),
  discordInteraction: (_request, env, ctx, grant) =>
    routeInteraction((grant as DiscordInteractionPrincipal).interaction, env, ctx),
  startGateway: async (_request, env) =>
    (await gatewayControlForbidden(env, "gateway.start")) ?? Response.json(await startGateway(env)),
  stopGateway: async (_request, env) =>
    (await gatewayControlForbidden(env, "gateway.stop")) ?? Response.json(await stopGateway(env)),
  gatewayHealth: async (_request, env) =>
    (await gatewayControlForbidden(env, "gateway.health")) ?? Response.json(await getGatewayHealth(env)),
});

const DISCORD_INTERACTIONS_PATH = "/discord";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    await ensureRegistered(env, GATEWAY_MANIFEST);
    // Opportunistic wake-up (B): an incoming interaction webhook arrives over
    // HTTP independently of the gateway websocket, so use it to ensure the
    // socket is up. This brings the connection back the instant a command is
    // used after a deploy, without waiting for the cron tick.
    if (request.method === "POST" && new URL(request.url).pathname === DISCORD_INTERACTIONS_PATH) {
      ctx.waitUntil(ensureGatewayConnected(env));
    }
    return router.handle(request, env, ctx);
  },
  // Cron trigger (A): the platform wakes the gateway on a schedule so the
  // websocket self-establishes after any deploy and self-heals, with no manual
  // /gateway/start. ensureConnected() is a no-op if the operator stopped it.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(ensureGatewayConnected(env));
  },
};
