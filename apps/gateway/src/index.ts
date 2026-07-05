import {
  extractBotMentionPrompt,
  handleGatewayMessageCreate,
} from "@rag/discord/domain/mention";
import type { Env } from "@rag/discord/contracts";
import {
  DiscordGateway,
  ensureGatewayConnected,
  getGatewayHealth,
  startGateway,
  stopGateway,
} from "./gateway";
import { OPENAPI } from "./openapi";
import { createGatewayRouter } from "./router";

export { DiscordGateway, extractBotMentionPrompt, handleGatewayMessageCreate };

// Control routes (start/stop/health) are authenticated by the operator bearer
// token the router wires from the spec's security scheme; holding that token IS
// the authorization, so there is no second (Cedar) gate. Handlers are keyed by
// generated OpenAPI operationId.
const router = createGatewayRouter({
  openApiJson: () => Response.json(OPENAPI),
  // Key-discovery documents kept for relying-party compatibility. Per-worker
  // signing keys have been removed, so the key set is now empty.
  oauthAuthorizationServerMetadata: (request) => {
    const origin = new URL(request.url).origin;
    return Response.json({ issuer: origin, jwks_uri: `${origin}/.well-known/jwks.json` });
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
  jwks: () => Response.json({ keys: [] }, { headers: { "Cache-Control": "public, max-age=3600" } }),
  startGateway: async (_request, env) => Response.json(await startGateway(env)),
  stopGateway: async (_request, env) => Response.json(await stopGateway(env)),
  gatewayHealth: async (_request, env) => Response.json(await getGatewayHealth(env)),
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return router.handle(request, env, ctx);
  },
  // Cron trigger: the platform wakes the gateway on a schedule so the websocket
  // self-establishes after any deploy and self-heals, with no manual
  // /gateway/start. ensureConnected() is a no-op if the operator stopped it.
  // (Discord interactions now arrive at the webhooks worker, not here, so the
  // former opportunistic HTTP wake-up is gone; the cron plus the DiscordGateway
  // DO's own watchdog alarm keep the socket up.)
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(ensureGatewayConnected(env));
  },
};
