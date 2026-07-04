import { cloudflareAccessGuard } from "@rag/ingress/cf-access";
import { createEdgeWorker, jsonResponse, pathPrefix, prepareApplicationHop } from "@rag/service-kit/edge";
import { encodeRegistryInvokeEnvelope } from "../../../../../contracts";
import type { Env, RegistryInvokeOperation, RegistryInvokeResult } from "../../../../../contracts";
import { errorMessage, logger } from "@rag/logger";
import { REGISTRY_APPLICATION_ID_PATTERN } from "../../../../../lib/registry-kit/types";
import { AuthUnconfiguredError, createAuth, resolveDiscordSubject } from "@rag/ingress/better-auth";
import {
  ApplicationAuthority,
  ApplicationRegistry,
  REGISTRY_MANIFEST,
  RegistryService,
  ServiceRegistry,
} from "../../../service_server/src";
import { OPENAPI } from "./openapi";

// The registry worker hosts the control-plane Durable Objects:
// - ServiceRegistry: request placement and current manifest snapshot.
// - ApplicationRegistry: the user-facing registry application backing
//   registry.jsmunro.me application CRUD and scaffold requests.
// - ApplicationAuthority: the per-application authority (idFromName(appId))
//   that owns each application's members + signing key and mints act-as tokens.
export { ServiceRegistry };
export { ApplicationRegistry };
export { ApplicationAuthority };
export { RegistryService };

const parseBody = async (request: Request): Promise<unknown | Response> => {
  try {
    return await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }
};

type RegistryActor = { discordId: string; accessSub: string; email?: string };

const authenticate = async (request: Request, env: Env): Promise<
  | RegistryActor
  | Response
> => {
  const access = await cloudflareAccessGuard.verify(request, env);
  if (!access.ok) {
    return access.response;
  }
  try {
    const subject = await resolveDiscordSubject(createAuth(env), request.headers);
    if (!subject || subject.accessSub !== access.grant.identity.sub) {
      return jsonResponse(401, { error: "unauthorized" });
    }
    return {
      discordId: subject.discordId,
      accessSub: access.grant.identity.sub,
      ...(subject.email ? { email: subject.email } : {}),
    };
  } catch (error) {
    if (error instanceof AuthUnconfiguredError) {
      logger.error("registry_auth_unconfigured", { error: errorMessage(error) });
      return jsonResponse(500, { error: "misconfigured" });
    }
    throw error;
  }
};

const invokeRegistry = async (
  env: Env,
  actor: RegistryActor,
  operation: RegistryInvokeOperation,
  body: Record<string, unknown> = {},
  targetId?: string,
): Promise<RegistryInvokeResult> => {
  if (!env.REGISTRY_SERVICE) {
    return { status: 500, body: { error: "registry_service_unbound" } };
  }
  const message = await prepareApplicationHop({
    env,
    self: "registry",
    target: "registry",
    subject: actor.discordId,
    manifest: REGISTRY_MANIFEST,
    envelope: encodeRegistryInvokeEnvelope(
      {
        kind: "registry.invoke",
        operation,
        actorJson: JSON.stringify(actor),
        bodyJson: JSON.stringify(body),
        ...(targetId ? { targetId } : {}),
      },
      { source: "worker" },
    ),
  });
  return env.REGISTRY_SERVICE.invoke(message);
};

const relay = (result: RegistryInvokeResult): Response => jsonResponse(result.status, result.body);

const asRecordBody = (body: unknown): Record<string, unknown> =>
  typeof body === "object" && body !== null ? body as Record<string, unknown> : {};

const handleApplications = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const actor = await authenticate(request, env);
  if (actor instanceof Response) {
    return actor;
  }
  if (request.method === "GET" && url.pathname === "/api/applications") {
    return relay(await invokeRegistry(env, actor, "application.list"));
  }

  if (request.method === "POST" && url.pathname === "/api/applications") {
    const body = await parseBody(request);
    if (body instanceof Response) {
      return body;
    }
    try {
      return relay(await invokeRegistry(env, actor, "application.create", asRecordBody(body)));
    } catch (error) {
      return jsonResponse(400, { error: "invalid_request", detail: errorMessage(error) });
    }
  }

  const attestationMatch = url.pathname.match(/^\/api\/applications\/([^/]+)\/attestations\/verify$/);
  if (attestationMatch && request.method === "POST") {
    const id = decodeURIComponent(attestationMatch[1]);
    if (!REGISTRY_APPLICATION_ID_PATTERN.test(id)) {
      return jsonResponse(404, { error: "not_found" });
    }
    return relay(await invokeRegistry(env, actor, "application.attestations.verify", {}, id));
  }

  const match = url.pathname.match(/^\/api\/applications\/([^/]+)$/);
  if (!match) {
    return jsonResponse(404, { error: "not_found" });
  }
  const id = decodeURIComponent(match[1]);
  if (!REGISTRY_APPLICATION_ID_PATTERN.test(id)) {
    return jsonResponse(404, { error: "not_found" });
  }

  if (request.method === "GET") {
    return relay(await invokeRegistry(env, actor, "application.get", {}, id));
  }

  if (request.method === "PUT") {
    const body = await parseBody(request);
    if (body instanceof Response) {
      return body;
    }
    return relay(await invokeRegistry(env, actor, "application.update", asRecordBody(body), id));
  }

  if (request.method === "DELETE") {
    return relay(await invokeRegistry(env, actor, "application.delete", {}, id));
  }

  return jsonResponse(405, { error: "method_not_allowed" });
};

export default createEdgeWorker<Env>({
  service: "registry",
  manifest: REGISTRY_MANIFEST,
  openapi: OPENAPI,
  // Cloudflare Access is the perimeter for EVERYTHING on this hostname,
  // including health and openapi.
  guard: async (request, env) => {
    const access = await cloudflareAccessGuard.verify(request, env);
    return access.ok ? null : access.response;
  },
  routes: [
    {
      // Better Auth owns its own sub-router (session, OAuth callbacks).
      match: pathPrefix("/api/auth/"),
      handler: async (request, env) => {
        try {
          return await createAuth(env).handler(request);
        } catch (error) {
          if (error instanceof AuthUnconfiguredError) {
            logger.error("registry_auth_unconfigured", { error: errorMessage(error) });
            return jsonResponse(500, { error: "misconfigured" });
          }
          throw error;
        }
      },
    },
    {
      match: "/",
      methods: {
        GET: () =>
          new Response("ragbot registry", {
            headers: { "content-type": "text/plain; charset=utf-8" },
          }),
      },
    },
    {
      match: (url) =>
        url.pathname === "/api/applications" || url.pathname.startsWith("/api/applications/")
          ? []
          : null,
      handler: (request, env, _ctx) => handleApplications(request, env, new URL(request.url)),
    },
  ],
});
