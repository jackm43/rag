import { discordInteractionGuard } from "../../../../../../packages/boundaries/inbound/discord-interaction";
import { operatorControlGuard } from "../../../../../../packages/boundaries/inbound/operator-control";
import type { InboundGuard } from "../../../../../../packages/boundaries/inbound/guard";
import type { Env } from "../../../../../../packages/contracts/types";
import { GATEWAY_ROUTES, type GatewaySecurityScheme } from "./routes";

// The gateway's HTTP surface is constructed from generated route bindings:
// unknown paths 404, undeclared methods 405 with the generated Allow set, and
// each operation's security scheme selects the ingress guard that must pass
// before its handler runs. Handlers are keyed by operationId; a generated
// operation without a handler fails construction, so the worker cannot deploy
// with an unimplemented route.

export type OperationHandler = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  grant: unknown,
) => Response | Promise<Response>;

const GUARDS: Record<GatewaySecurityScheme, InboundGuard<unknown>> = {
  discordSignature: discordInteractionGuard,
  controlToken: operatorControlGuard,
};

export type GatewayRouter = {
  handle: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
};

export const createGatewayRouter = (handlers: Record<string, OperationHandler>): GatewayRouter => {
  for (const routes of Object.values(GATEWAY_ROUTES)) {
    for (const route of routes) {
      if (!handlers[route.operationId]) {
        throw new Error(`gateway operation "${route.operationId}" has no handler`);
      }
    }
  }

  return {
    handle: async (request, env, ctx) => {
      const routes = GATEWAY_ROUTES[new URL(request.url).pathname];
      if (!routes) {
        return new Response("Not found", { status: 404 });
      }

      const route = routes.find((candidate) => candidate.method === request.method);
      if (!route) {
        return new Response("Method not allowed", {
          status: 405,
          headers: { Allow: routes.map((candidate) => candidate.method).join(", ") },
        });
      }

      let grant: unknown;
      if (route.security) {
        const result = await GUARDS[route.security].verify(request, env);
        if (!result.ok) {
          return result.response;
        }
        grant = result.grant;
      }

      return handlers[route.operationId](request, env, ctx, grant);
    },
  };
};
