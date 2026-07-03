import { z } from "zod";

import { ensureRegistered, serviceClients } from "../../../../packages/auth";
import { cloudflareAccessGuard } from "../../../../packages/boundaries/inbound/cf-access";
import { connectorsClient } from "../../../../packages/connectors";
import { encodeDevProxyCommandEnvelope } from "../../../../packages/contracts";
import type { ConnectorResult, DevProxyCommandJob, Env } from "../../../../packages/contracts/types";
import { errorMessage, logger } from "../../../../packages/logger";
import type { components } from "../../../../packages/devproxy-client/api-types";
import { AuthUnconfiguredError, createAuth, resolveDiscordSubject, type ResolvedSubject } from "./auth";
import { DEV_PROXY_MANIFEST } from "./manifest";
import { DEV_PROXY_PAGE } from "./page";

// The dev-proxy worker: the human-facing admin application for ragbot. It runs
// in production so an operator can drive the real gateway → brain command path
// (and, over time, other sensitive service surfaces) against real data with no
// separate dev environment.
//
// Its ingress is a LAYERED auth model, outer gate to inner:
//   1. Cloudflare Access (perimeter). The whole worker sits behind an Access
//      application; every request — including the login endpoints — must carry a
//      cryptographically verified Access JWT (cf-access guard). This proves the
//      request came from a team member through Access.
//   2. Better Auth with Discord OAuth (app identity), running BEHIND Access. The
//      logged-in user's Discord account id is the acting subject. Each session is
//      bound at creation to the Access identity that made it (session.accessSub),
//      and the command gate refuses a session presented under any other Access
//      identity — so a leaked session cookie cannot be replayed cross-identity.
//   3. On a command, the worker mints an on-behalf-of identity-context token
//      (sub = the acting Discord id) and invokes the gateway's DevProxy service-
//      binding entrypoint, which authorizes the app AND re-checks the acting
//      subject against its own allowlist before running the ordinary command
//      pre-flight (Cedar authZ). See README.md "Dev proxy".

// Command request body. Kept deliberately narrow: the command name and options
// are the only client-supplied inputs; the acting subject, guild, application
// id, and interaction token are set by the worker (subject from the session),
// never by the caller.
const CommandRequest = z.object({
  command: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  channelId: z
    .string()
    .regex(/^\d{17,20}$/)
    .optional(),
  options: z
    .array(z.object({ name: z.string().min(1).max(32), value: z.string().max(4000) }))
    .max(25)
    .optional(),
});

// A connector id path parameter: the same slug shape the broker validates.
const CONNECTOR_ID = /^[a-z][a-z0-9-]{0,63}$/;

// Set / re-point a connector's secret. `provider` names the backend; `ref` is
// its locator; `value`, when present, is the secret material — it flows INWARD
// only (to the broker, then the backend) and is never returned. A value with no
// ref is refused (nowhere to write it); at least one of ref/value is required.
const SetConnectorSecretRequest = z
  .object({
    provider: z.enum([
      "wrangler-env",
      "cloudflare-secret-store",
      "hashicorp-vault",
      "onepassword",
    ]),
    ref: z.string().min(1).max(512).optional(),
    value: z.string().min(1).max(65536).optional(),
  })
  .refine((body) => body.ref !== undefined || body.value !== undefined, {
    message: "ref or value is required",
  })
  .refine((body) => !(body.value !== undefined && body.ref === undefined), {
    message: "ref is required when a value is supplied",
  });

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// Gate 2, shared by every authenticated endpoint (the command surface and the
// connectors admin surface). The perimeter (Access) has already been verified by
// the fetch handler and its subject is passed in; this resolves the Better Auth
// Discord session and binds it to THIS request's Access identity. Returns the
// acting subject, or a fail-closed Response (500 misconfigured / 401) that the
// caller returns verbatim. Factored out so the admin endpoints authenticate
// IDENTICALLY to /api/command — one gate, no drift.
type Gate2 = { subject: ResolvedSubject } | { error: Response };

const authenticateSession = async (request: Request, env: Env, accessSub: string): Promise<Gate2> => {
  let auth: ReturnType<typeof createAuth>;
  try {
    auth = createAuth(env);
  } catch (error) {
    if (error instanceof AuthUnconfiguredError) {
      logger.error("dev_proxy_auth_unconfigured", { error: errorMessage(error) });
      return { error: json(500, { error: "misconfigured" }) };
    }
    throw error;
  }

  // A valid Better Auth session with a linked Discord account, bound to this
  // request's Access identity. Any of: no session, no Discord link, or an
  // Access-subject mismatch is a fail-closed 401.
  const subject = await resolveDiscordSubject(auth, request.headers);
  if (!subject) {
    logger.warn("ingress_denied", {
      identity: "better-auth",
      zone: "untrusted",
      transport: "http",
      outcome: "denied",
      reason: "no_session",
    });
    return { error: json(401, { error: "unauthorized" }) };
  }
  if (subject.accessSub !== accessSub) {
    // The session was created under a different Access identity than the one
    // presenting it now: a cross-identity replay of the session cookie.
    logger.warn("ingress_denied", {
      identity: "better-auth",
      zone: "untrusted",
      transport: "http",
      outcome: "denied",
      reason: "access_binding_mismatch",
    });
    return { error: json(401, { error: "unauthorized" }) };
  }
  return { subject };
};

// Command dispatch, behind the shared Gate 2.
const handleCommand = async (request: Request, env: Env, accessSub: string): Promise<Response> => {
  const gate = await authenticateSession(request, env, accessSub);
  if ("error" in gate) {
    return gate.error;
  }
  const subject = gate.subject;

  let body: z.infer<typeof CommandRequest>;
  try {
    // `satisfies` is a compile-time link: the zod-parsed shape must conform to
    // the OpenAPI CommandRequest contract (openapi.yaml → api-types.ts) that the
    // generated app-client promises, so ingress and client cannot drift.
    body = CommandRequest.parse(await request.json()) satisfies components["schemas"]["CommandRequest"];
  } catch {
    return json(400, { error: "invalid_request" });
  }

  const gateway = env.GATEWAY_DEVPROXY;
  if (!gateway) {
    logger.error("devproxy_binding_missing", {});
    return json(500, { error: "misconfigured" });
  }

  const job: DevProxyCommandJob = {
    kind: "devproxy.command",
    command: body.command,
    // The acting subject is the authenticated Discord user, resolved from the
    // session — never a caller input and no longer a static env default. The
    // gateway independently re-checks it against DEV_PROXY_ALLOWED_SUBJECTS.
    subjectUserId: subject.discordId,
    subjectUsername: subject.email ?? subject.discordId,
    ...(env.DEV_PROXY_GUILD ? { guildId: env.DEV_PROXY_GUILD } : {}),
    ...(body.channelId ? { channelId: body.channelId } : {}),
    // No interaction credentials: the gateway runs the command synchronously and
    // returns the real result to this response, so there is no deferred Discord
    // PATCH to carry a token for. Commands that can only deliver asynchronously
    // (bicture, ragjam) are withheld by the dev-proxy capability policy.
    options: body.options ?? [],
  };

  try {
    const envelope = encodeDevProxyCommandEnvelope(job, {
      source: "worker",
      guildId: job.guildId,
    });
    // Mint the on-behalf-of token: sub is the acting Discord user (the session
    // subject). No sender-constraint claim is carried — binding the session to
    // the Access identity, not a per-request proof, is what constrains it.
    const message = await serviceClients(env).devProxyToGateway.prepare(envelope, {
      sub: subject.discordId,
    });
    const result = await gateway.invokeCommand(message);
    return new Response(result.body, {
      status: result.status,
      headers: { "content-type": result.contentType },
    });
  } catch (error) {
    logger.error("devproxy_call_failed", { command: job.command, error: errorMessage(error) });
    return json(502, { error: "upstream_error" });
  }
};

// Map the broker's coarse fail-closed status to an HTTP status for the browser.
// Anything that is not a client-shaped denial the broker states (400/401/403/404)
// is relayed as a 502 upstream error — the broker never discloses why it refused.
const brokerHttpStatus = (status: number): number =>
  status === 200 || status === 400 || status === 401 || status === 403 || status === 404 ? status : 502;

// Relay a successful broker admin result (or its denial). `pick` selects the
// secret-free body to return; a non-200 broker status becomes a bare error.
const relay = (result: ConnectorResult, pick: (result: ConnectorResult) => unknown): Response =>
  result.status === 200 ? json(200, pick(result)) : json(brokerHttpStatus(result.status), { error: "broker_error" });

// set-secret is a broker-status-200 op whose outcome rides in secret.status; map
// that outcome to an HTTP status (a runtime write = 200, an out-of-band
// provisioning still required = 202, a refused op = 409). Never leaks the value —
// the broker never returns it and neither do we.
const SET_SECRET_HTTP: Record<string, number> = {
  written: 200,
  referenced: 200,
  provision_required: 202,
  rejected: 409,
};

const relaySetSecret = (result: ConnectorResult): Response => {
  if (result.status !== 200 || !result.secret) {
    return json(brokerHttpStatus(result.status), { error: "broker_error" });
  }
  return json(SET_SECRET_HTTP[result.secret.status] ?? 200, { secret: result.secret });
};

// The connectors ADMIN surface (/api/connectors/*, /api/secrets/providers),
// behind the SAME layered auth as /api/command (Access verified by the fetch
// handler, then the shared Gate 2 session + Access-binding check). Each endpoint
// mints an on-behalf-of identity token (sub = the acting Discord admin) and
// invokes the connectors broker over the CONNECTORS binding, exactly like
// /api/command drives the gateway. Secret values flow inward only; no response
// ever carries one.
const handleConnectorsApi = async (
  request: Request,
  env: Env,
  accessSub: string,
  url: URL,
): Promise<Response> => {
  const gate = await authenticateSession(request, env, accessSub);
  if ("error" in gate) {
    return gate.error;
  }
  if (!env.CONNECTORS) {
    logger.error("connectors_binding_missing", {});
    return json(500, { error: "misconfigured" });
  }
  // The on-behalf-of hop: sub is the acting Discord admin (the session subject),
  // exactly as /api/command mints for the gateway.
  const client = connectorsClient(env, serviceClients(env).devProxyToConnectors, {
    sub: gate.subject.discordId,
  });
  const { pathname } = url;
  const method = request.method;

  if (method === "GET" && pathname === "/api/secrets/providers") {
    return relay(await client.getSecretsProviders(), (result) => ({ providers: result.providers ?? [] }));
  }
  if (method === "GET" && pathname === "/api/connectors") {
    return relay(await client.listConnectors(), (result) => ({ connectors: result.connectors ?? [] }));
  }

  // /api/connectors/{id} and its sub-resources.
  const match = pathname.match(/^\/api\/connectors\/([^/]+)(\/[a-z]+)?$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    if (!CONNECTOR_ID.test(id)) {
      return json(400, { error: "invalid_connector_id" });
    }
    const sub = match[2];

    if (!sub && method === "GET") {
      return relay(await client.describeConnector(id), (result) => ({ connector: result.connector }));
    }
    if (sub === "/secret" && method === "PUT") {
      let body: z.infer<typeof SetConnectorSecretRequest>;
      try {
        // `satisfies` links the zod shape to the OpenAPI contract (api-types),
        // so ingress and the documented schema cannot drift.
        body = SetConnectorSecretRequest.parse(
          await request.json(),
        ) satisfies components["schemas"]["SetConnectorSecretRequest"];
      } catch {
        return json(400, { error: "invalid_request" });
      }
      return relaySetSecret(await client.setConnectorSecret(id, body));
    }

    // Reserved: documented in openapi.yaml but not yet implemented, so the
    // contract is stable while grant/installations/callback wiring lands later.
    if (sub === "/grant" && method === "POST") {
      return json(501, { error: "not_implemented" });
    }
    if (sub === "/installations" && method === "GET") {
      return json(501, { error: "not_implemented" });
    }
    if (sub === "/callback" && (method === "GET" || method === "POST")) {
      return json(501, { error: "not_implemented" });
    }
  }

  return json(404, { error: "not_found" });
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    ctx.waitUntil(ensureRegistered(env, DEV_PROXY_MANIFEST));
    const url = new URL(request.url);

    // Perimeter (gate 1) on EVERY request, including the login endpoints: the
    // browser holds the Access cookie, so the Discord OAuth callback passes
    // Access fine, and nothing behind Access is reachable without a verified
    // Access JWT. Fails closed to the guard's 401 when Access is unconfigured.
    const access = await cloudflareAccessGuard.verify(request, env);
    if (!access.ok) {
      return access.response;
    }

    // Better Auth owns login, session, and the Discord OAuth callback under
    // /api/auth/*. It runs behind Access and enforces its own CSRF/origin checks.
    if (url.pathname.startsWith("/api/auth/")) {
      try {
        return await createAuth(env).handler(request);
      } catch (error) {
        if (error instanceof AuthUnconfiguredError) {
          logger.error("dev_proxy_auth_unconfigured", { error: errorMessage(error) });
          return json(500, { error: "misconfigured" });
        }
        throw error;
      }
    }

    // The single-page admin UI. Behind Access; it hosts the "Sign in with
    // Discord" button and the command form (which posts with the session cookie).
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(DEV_PROXY_PAGE, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (request.method === "POST" && url.pathname === "/api/command") {
      return handleCommand(request, env, access.grant.identity.sub);
    }

    // The connectors admin surface, behind the same layered auth as /api/command.
    if (url.pathname === "/api/connectors" || url.pathname.startsWith("/api/connectors/") || url.pathname === "/api/secrets/providers") {
      return handleConnectorsApi(request, env, access.grant.identity.sub, url);
    }

    return new Response("Not found", { status: 404 });
  },
};
