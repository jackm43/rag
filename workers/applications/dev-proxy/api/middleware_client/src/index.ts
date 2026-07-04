import { z } from "zod";

import { createClient, createHopIntent, ensureRegistered } from "../../../../../../packages/auth";
import { cloudflareAccessGuard } from "../../../../../../packages/boundaries/inbound/cf-access";
import { connectorsClient } from "../../../../../../packages/connectors";
import { encodeDevProxyCommandEnvelope } from "../../../../../../packages/contracts";
import type { ConnectorResult, DevProxyCommandJob, Env } from "../../../../../../packages/contracts/types";
import { errorMessage, logger } from "../../../../../../packages/logger";
import type { components } from "../../../../../../packages/devproxy-client/api-types";
import {
  AuthUnconfiguredError,
  createAuth,
  resolveDiscordSubject,
  type ResolvedSubject,
} from "../../../../../../packages/boundaries/inbound/better-auth";
import { OPENAPI } from "./openapi";
import { DEV_PROXY_PAGE } from "./page";
import { DEV_PROXY_MANIFEST } from "../../../service_server/src";

// The dev-proxy worker: the human-facing admin application for ragbot. It runs
// in production so an operator can drive the real gateway → workflows command path
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

// A 3LO callback completion: the provider's authorization code + the broker-
// minted state. Both are provider-opaque handles, validated only for presence
// and a sane bound. The code is SENSITIVE — it flows to the broker only and is
// never logged or echoed back.
const CompleteAuthorizationRequest = z.object({
  code: z.string().min(1).max(2048),
  state: z.string().min(1).max(2048),
});

const GITHUB_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const GithubApiRequest = z
  .object({
    installationId: z.string().regex(/^\d{1,20}$/),
    method: z.enum(GITHUB_METHODS).optional(),
    path: z.string().min(1).max(2048).regex(/^\//).optional(),
    route: z
      .string()
      .min(5)
      .max(2048)
      .regex(/^(GET|POST|PUT|PATCH|DELETE)\s+\//)
      .optional(),
    params: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
    headers: z.record(z.string().min(1).max(128), z.string().max(4096)).optional(),
    body: z.string().max(1024 * 1024).optional(),
  })
  .refine((body) => body.route !== undefined || (body.method !== undefined && body.path !== undefined), {
    message: "route or method/path is required",
  });

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const html = (status: number, body: string): Response =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

// Escape untrusted text for interpolation into the callback page. The OAuth
// error params (error/error_description) are attacker-influenced query values
// and must never reach the page unescaped.
const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
  );

// The minimal self-contained page the admin's browser lands on after the 3LO
// provider redirect (GET callback) — the visual style matches page.ts. `detail`
// is escaped here, so no caller can forget.
const callbackPage = (ok: boolean, detail: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ragbot admin — authorization</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.2rem; }
  p.ok { color: #166534; }
  p.err { color: #991b1b; }
  .muted { color: #71717a; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>ragbot admin</h1>
<p class="${ok ? "ok" : "err"}">${ok ? "Authorization complete" : "Authorization failed"} — ${escapeHtml(detail)}.</p>
<p class="muted">${ok ? "You can close this tab, or go " : "Nothing was authorized. Go "}<a href="/">back to the admin page</a>.</p>
</body>
</html>`;

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
      zone: "platform",
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
      zone: "platform",
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
    const message = await createClient({
      env,
      self: "dev-proxy",
      context: { subject: subject.discordId },
    }).to("gateway", { transportTrust: "application" }).prepare(envelope, {
      intent: createHopIntent({
        action: "devproxy.command",
        resourceType: "Gateway",
        resourceId: job.guildId ?? "unknown",
        method: job.command,
      }),
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

const handleGithubApi = async (request: Request, env: Env, accessSub: string): Promise<Response> => {
  const gate = await authenticateSession(request, env, accessSub);
  if ("error" in gate) {
    return gate.error;
  }
  if (!env.CONNECTORS) {
    logger.error("connectors_binding_missing", {});
    return json(500, { error: "misconfigured" });
  }

  let body: z.infer<typeof GithubApiRequest>;
  try {
    body = GithubApiRequest.parse(await request.json());
  } catch (error) {
    return json(400, {
      error: "invalid_request",
      detail: error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join("; ") : "request body must be JSON",
    });
  }

  const client = connectorsClient(env, createClient({
    env,
    self: "dev-proxy",
    context: { subject: gate.subject.discordId },
  }).to("connectors", { transportTrust: "application" }));
  const granted = await client.grant("github-app", {
    params: { installationId: body.installationId },
  });
  if (granted.status !== 200 || !granted.grant) {
    return json(brokerHttpStatus(granted.status), { error: "broker_error" });
  }

  const route = expandGithubRequest(body);
  if (!route.ok) {
    return json(400, { error: "invalid_request", detail: route.detail });
  }

  const fetched = await client.authorizedFetch(granted.grant.handle, {
    method: route.request.method,
    path: route.request.path,
    ...(body.headers ? { headers: body.headers } : {}),
    ...(route.request.body !== undefined ? { body: route.request.body } : {}),
  });
  if (fetched.status !== 200 || !fetched.fetch) {
    return json(brokerHttpStatus(fetched.status), { error: "broker_error" });
  }
  return json(200, { github: fetched.fetch });
};

const handleGithubRoutes = async (env: Env): Promise<Response> => {
  const object = await env.DEVPROXY_ASSETS?.get("github/rest-routes.json");
  if (!object) {
    return json(503, { error: "github_routes_unavailable" });
  }
  const headers = new Headers({
    "content-type": object.httpMetadata?.contentType ?? "application/json",
    "cache-control": "private, max-age=3600",
    etag: object.httpEtag,
  });
  return new Response(object.body, { headers });
};

type ExpandedGithubRequest =
  | { ok: true; request: { method: (typeof GITHUB_METHODS)[number]; path: string; body?: string } }
  | { ok: false; detail: string };

const expandGithubRequest = (body: z.infer<typeof GithubApiRequest>): ExpandedGithubRequest => {
  if (!body.route) {
    return body.method && body.path
      ? { ok: true, request: { method: body.method, path: body.path, ...(body.body !== undefined ? { body: body.body } : {}) } }
      : { ok: false, detail: "route or method/path is required" };
  }

  const match = body.route.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(.+)$/);
  if (!match) {
    return { ok: false, detail: "route must look like `GET /path/{param}`" };
  }
  const method = match[1] as (typeof GITHUB_METHODS)[number];
  let path = match[2];
  const params = body.params ?? {};
  const used = new Set<string>();
  const missing: string[] = [];
  path = path.replace(/\{([^}]+)\}/g, (_placeholder, rawName: string) => {
    const name = rawName.replace(/^\+/, "");
    const value = params[name];
    if (value === undefined || value === "") {
      missing.push(name);
      return "";
    }
    used.add(name);
    return encodeURIComponent(String(value));
  });
  if (missing.length > 0) {
    return { ok: false, detail: `missing route params: ${missing.join(", ")}` };
  }

  const rest = Object.entries(params).filter(([key, value]) => !used.has(key) && value !== "");
  if (method === "GET" || method === "DELETE") {
    const query = new URLSearchParams();
    for (const [key, value] of rest) {
      query.set(key, String(value));
    }
    const separator = path.includes("?") ? "&" : "?";
    return { ok: true, request: { method, path: query.size ? `${path}${separator}${query.toString()}` : path, ...(body.body !== undefined ? { body: body.body } : {}) } };
  }

  return {
    ok: true,
    request: {
      method,
      path,
      body: body.body !== undefined ? body.body : rest.length ? JSON.stringify(Object.fromEntries(rest)) : undefined,
    },
  };
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
  const client = connectorsClient(env, createClient({
    env,
    self: "dev-proxy",
    context: { subject: gate.subject.discordId },
  }).to("connectors", { transportTrust: "application" }));
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

    // Admin-initiated 3LO begin: ask the broker for the provider consent URL.
    // The acting subject is the session's Discord admin (the same on-behalf-of
    // token as every other admin op); the broker persists the returned state
    // AGAINST that subject, single-use, so only the same admin can complete. A
    // connector whose kind has no 3LO flow is the broker's fail-closed 400,
    // relayed honestly like every other coarse denial.
    if (sub === "/grant" && method === "POST") {
      const result = await client.beginAuthorization(id, {});
      if (result.status !== 200 || !result.authorization) {
        return json(brokerHttpStatus(result.status), { error: "broker_error" });
      }
      return json(200, {
        url: result.authorization.url,
        state: result.authorization.state,
        connectorId: id,
      } satisfies components["schemas"]["GrantAuthorizationResult"]);
    }
    // A github_app connector's App installations (id + account + repository
    // selection) for the admin UI's installation picker. The App JWT that lists
    // them stays broker-side; any other kind is the broker's 400.
    if (sub === "/installations" && method === "GET") {
      return relay(await client.listInstallations(id), (result) => ({
        installations: result.installations ?? [],
      }));
    }
    // 3LO completion. GET is the provider's browser redirect back from the
    // consent page (?code=&state=, or ?error= on denial) — the admin's browser
    // still carries the Access cookie and the session, so the SAME layered auth
    // gates completion as begin, and the broker additionally enforces that the
    // completing subject is the one its single-use state was minted for. The
    // code is sensitive: forwarded to the broker only, never logged or echoed.
    if (sub === "/callback" && method === "GET") {
      const providerError = url.searchParams.get("error");
      if (providerError !== null) {
        // The provider denied (e.g. access_denied): report honestly, without
        // ever calling the broker. callbackPage escapes both params.
        const description = url.searchParams.get("error_description");
        return html(400, callbackPage(false, providerError + (description ? `: ${description}` : "")));
      }
      const parsed = CompleteAuthorizationRequest.safeParse({
        code: url.searchParams.get("code"),
        state: url.searchParams.get("state"),
      });
      if (!parsed.success) {
        return html(400, callbackPage(false, "the redirect is missing its code or state"));
      }
      const result = await client.completeAuthorization(id, parsed.data);
      return result.status === 200
        ? html(200, callbackPage(true, `the broker stored ${id}'s tokens for your account`))
        : html(brokerHttpStatus(result.status), callbackPage(false, "the broker refused the completion"));
    }
    // The API-driven completion variant: the same params as JSON, JSON out.
    if (sub === "/callback" && method === "POST") {
      let body: z.infer<typeof CompleteAuthorizationRequest>;
      try {
        // `satisfies` links the zod shape to the OpenAPI contract (api-types),
        // so ingress and the documented schema cannot drift.
        body = CompleteAuthorizationRequest.parse(
          await request.json(),
        ) satisfies components["schemas"]["CompleteAuthorizationRequest"];
      } catch {
        return json(400, { error: "invalid_request" });
      }
      const result = await client.completeAuthorization(id, body);
      return result.status === 200
        ? json(200, {
            authorized: true,
            connectorId: id,
          } satisfies components["schemas"]["CompleteAuthorizationResult"])
        : json(brokerHttpStatus(result.status), { error: "broker_error" });
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

    if (request.method === "GET" && url.pathname === "/openapi.json") {
      return new Response(JSON.stringify(OPENAPI), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
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
    // Discord" button and the command/API workbench forms (which post with the
    // session cookie). /apis and /github open focused views in the same SPA.
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/apis" || url.pathname === "/github")) {
      return new Response(DEV_PROXY_PAGE, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store, no-cache, must-revalidate",
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/api/command") {
      return handleCommand(request, env, access.grant.identity.sub);
    }

    if (request.method === "POST" && url.pathname === "/api/github") {
      return handleGithubApi(request, env, access.grant.identity.sub);
    }

    if (request.method === "GET" && url.pathname === "/api/github/routes") {
      return handleGithubRoutes(env);
    }

    // The connectors admin surface, behind the same layered auth as /api/command.
    if (url.pathname === "/api/connectors" || url.pathname.startsWith("/api/connectors/") || url.pathname === "/api/secrets/providers") {
      return handleConnectorsApi(request, env, access.grant.identity.sub, url);
    }

    return new Response("Not found", { status: 404 });
  },
};
