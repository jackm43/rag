import { cloudflareAccessGuard } from "@rag/ingress/cf-access";
import { createQueueWorker } from "@rag/service-kit";
import { createEdgeWorker, jsonResponse, pathPrefix, prepareApplicationHop } from "@rag/service-kit/edge";
import { encodeRegistryInvokeEnvelope } from "../../../../../contracts";
import type { Env, RegistryInvokeOperation, RegistryInvokeResult } from "../../../../../contracts";
import { errorMessage, logger } from "@rag/logger";
import { REGISTRY_APPLICATION_ID_PATTERN } from "../../../../../lib/registry-kit/types";
import {
  enqueueGrantRequest,
  GRANT_REQUEST_KINDS,
  isGrantArtifact,
  type GrantRequestKind,
} from "../../../../../lib/registry-kit/grants";
import { AuthUnconfiguredError, createAuth, resolveDiscordSubject } from "@rag/ingress/better-auth";
import {
  ApplicationAuthority,
  ApplicationRegistry,
  processGrantDlqMessage,
  processGrantQueueMessage,
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

  // Enqueue an application-authority grant request (register/revoke a client to
  // act as the application). The enqueue only ACKS the request onto the durable
  // control-plane queue; the authority DO applies it, waiting for the client's
  // production attestation if it is not yet on record. The operator polls the
  // returned requestId via GET .../grants/:requestId.
  const grantsMatch = url.pathname.match(/^\/api\/applications\/([^/]+)\/grants$/);
  if (grantsMatch && request.method === "POST") {
    const id = decodeURIComponent(grantsMatch[1]);
    if (!REGISTRY_APPLICATION_ID_PATTERN.test(id)) {
      return jsonResponse(404, { error: "not_found" });
    }
    if (!env.APPLICATION_GRANTS) {
      return jsonResponse(500, { error: "grants_queue_unbound" });
    }
    const body = await parseBody(request);
    if (body instanceof Response) {
      return body;
    }
    const record = asRecordBody(body);
    const kind = record.kind;
    const client = record.client;
    if (
      typeof kind !== "string" ||
      !(GRANT_REQUEST_KINDS as readonly string[]).includes(kind) ||
      typeof client !== "string" ||
      !REGISTRY_APPLICATION_ID_PATTERN.test(client)
    ) {
      return jsonResponse(400, { error: "invalid_grant_request" });
    }
    const artifact = kind === "grant.register" ? record.artifact : undefined;
    if (kind === "grant.register" && !isGrantArtifact(artifact)) {
      return jsonResponse(400, { error: "invalid_grant_request" });
    }
    const subject = typeof record.subject === "string" ? record.subject : undefined;
    try {
      const requestId = await enqueueGrantRequest(env.APPLICATION_GRANTS, {
        kind: kind as GrantRequestKind,
        appId: id,
        client,
        ...(isGrantArtifact(artifact) ? { artifact } : {}),
        ...(subject ? { subject } : {}),
      });
      return jsonResponse(202, { requestId, status: "pending" });
    } catch {
      return jsonResponse(400, { error: "invalid_grant_request" });
    }
  }

  // Result channel: read the live state of a previously enqueued grant request.
  const grantStatusMatch = url.pathname.match(/^\/api\/applications\/([^/]+)\/grants\/([^/]+)$/);
  if (grantStatusMatch && request.method === "GET") {
    const id = decodeURIComponent(grantStatusMatch[1]);
    const requestId = decodeURIComponent(grantStatusMatch[2]);
    if (!REGISTRY_APPLICATION_ID_PATTERN.test(id)) {
      return jsonResponse(404, { error: "not_found" });
    }
    if (!env.APPLICATION_AUTHORITY) {
      return jsonResponse(500, { error: "authority_unbound" });
    }
    const status = await env.APPLICATION_AUTHORITY.get(
      env.APPLICATION_AUTHORITY.idFromName(id),
    ).grantStatus(requestId);
    return jsonResponse(200, status);
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

// The registry worker is both an edge (HTTP) worker and a queue consumer: the
// edge serves registry.jsmunro.me + the grant-enqueue routes, and the consumer
// drains the `application-grants` control-plane queue into the authority DO.
const edge = createEdgeWorker<Env>({
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

const grants = createQueueWorker<Env>(REGISTRY_MANIFEST, {
  "application-grants": processGrantQueueMessage,
  "application-grants-dlq": processGrantDlqMessage,
});

export default {
  fetch: edge.fetch,
  queue: grants.queue,
};
