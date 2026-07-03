import { z } from "zod";

import { ensureRegistered, serviceClients } from "../../../../packages/auth";
import { cloudflareAccessGuard } from "../../../../packages/boundaries/inbound/cf-access";
import { encodeDevProxyCommandEnvelope } from "../../../../packages/contracts";
import type { DevProxyCommandJob, Env } from "../../../../packages/contracts/types";
import { errorMessage, logger } from "../../../../packages/logger";
import type { components } from "../../../../packages/devproxy-client/api-types";
import { AuthUnconfiguredError, createAuth, resolveDiscordSubject } from "./auth";
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

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// Gate 2 + command dispatch. The perimeter (Access) has already been verified by
// the caller and its subject is passed in, so the acting session can be checked
// against the exact Access identity of THIS request.
const handleCommand = async (request: Request, env: Env, accessSub: string): Promise<Response> => {
  let auth: ReturnType<typeof createAuth>;
  try {
    auth = createAuth(env);
  } catch (error) {
    if (error instanceof AuthUnconfiguredError) {
      logger.error("dev_proxy_auth_unconfigured", { error: errorMessage(error) });
      return json(500, { error: "misconfigured" });
    }
    throw error;
  }

  // Gate 2: a valid Better Auth session with a linked Discord account, bound to
  // this request's Access identity. Any of: no session, no Discord link, or an
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
    return json(401, { error: "unauthorized" });
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
    return json(401, { error: "unauthorized" });
  }

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

    return new Response("Not found", { status: 404 });
  },
};
