import { createClient, ensureRegistered } from "../../../../../../packages/auth";
import { cloudflareAccessGuard } from "../../../../../../packages/boundaries/inbound/cf-access";
import { encodeRegistryInvokeEnvelope } from "../../../../../../packages/contracts";
import type { Env, RegistryInvokeOperation, RegistryInvokeResult } from "../../../../../../packages/contracts/types";
import { errorMessage, logger } from "../../../../../../packages/logger";
import { REGISTRY_APPLICATION_ID_PATTERN } from "../../../../../../packages/registry/types";
import { AuthUnconfiguredError, createAuth, resolveDiscordSubject } from "../../../../../../packages/boundaries/inbound/better-auth";
import {
  ApplicationRegistry,
  REGISTRY_MANIFEST,
  RegistryService,
  ServiceRegistry,
} from "../../../service_server/src";
import { OPENAPI } from "./openapi";

// The registry worker hosts two control-plane Durable Objects:
// - ServiceRegistry: request placement and current manifest snapshot.
// - ApplicationRegistry: the user-facing registry application backing
//   registry.jsmunro.me application CRUD and scaffold requests.
export { ServiceRegistry };
export { ApplicationRegistry };
export { RegistryService };

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const parseBody = async (request: Request): Promise<unknown | Response> => {
  try {
    return await request.json();
  } catch {
    return json(400, { error: "invalid_json" });
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
      return json(401, { error: "unauthorized" });
    }
    return {
      discordId: subject.discordId,
      accessSub: access.grant.identity.sub,
      ...(subject.email ? { email: subject.email } : {}),
    };
  } catch (error) {
    if (error instanceof AuthUnconfiguredError) {
      logger.error("registry_auth_unconfigured", { error: errorMessage(error) });
      return json(500, { error: "misconfigured" });
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
  await ensureRegistered(env, REGISTRY_MANIFEST);
  const envelope = encodeRegistryInvokeEnvelope(
    {
      kind: "registry.invoke",
      operation,
      actorJson: JSON.stringify(actor),
      bodyJson: JSON.stringify(body),
      ...(targetId ? { targetId } : {}),
    },
    { source: "worker" },
  );
  const message = await createClient({
    env,
    self: "registry",
    context: { subject: actor.discordId },
    transportTrust: "application",
  }).to("registry").prepare(envelope);
  return env.REGISTRY_SERVICE.invoke(message);
};

const relay = (result: RegistryInvokeResult): Response => json(result.status, result.body);

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
      return json(400, { error: "invalid_request", detail: errorMessage(error) });
    }
  }

  const attestationMatch = url.pathname.match(/^\/api\/applications\/([^/]+)\/attestations\/verify$/);
  if (attestationMatch && request.method === "POST") {
    const id = decodeURIComponent(attestationMatch[1]);
    if (!REGISTRY_APPLICATION_ID_PATTERN.test(id)) {
      return json(404, { error: "not_found" });
    }
    return relay(await invokeRegistry(env, actor, "application.attestations.verify", {}, id));
  }

  const match = url.pathname.match(/^\/api\/applications\/([^/]+)$/);
  if (!match) {
    return json(404, { error: "not_found" });
  }
  const id = decodeURIComponent(match[1]);
  if (!REGISTRY_APPLICATION_ID_PATTERN.test(id)) {
    return json(404, { error: "not_found" });
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

  return json(405, { error: "method_not_allowed" });
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    ctx.waitUntil(ensureRegistered(env, REGISTRY_MANIFEST));
    const url = new URL(request.url);

    const access = await cloudflareAccessGuard.verify(request, env);
    if (!access.ok) {
      return access.response;
    }

    if (url.pathname.startsWith("/api/auth/")) {
      try {
        return await createAuth(env).handler(request);
      } catch (error) {
        if (error instanceof AuthUnconfiguredError) {
          logger.error("registry_auth_unconfigured", { error: errorMessage(error) });
          return json(500, { error: "misconfigured" });
        }
        throw error;
      }
    }

    if (request.method === "GET" && url.pathname === "/openapi.json") {
      return json(200, OPENAPI);
    }

    if (url.pathname === "/health") {
      return json(200, { ok: true, service: "registry" });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return new Response("ragbot registry", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === "/api/applications" || url.pathname.startsWith("/api/applications/")) {
      return handleApplications(request, env, url);
    }

    return new Response("Not found", { status: 404 });
  },
};
