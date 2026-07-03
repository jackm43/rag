import { z } from "zod";

import { ensureRegistered, serviceClients } from "../../../../packages/auth";
import { cloudflareAccessGuard } from "../../../../packages/boundaries/inbound/cf-access";
import { verifyDpopProof, type DpopReplayStore } from "../../../../packages/boundaries/inbound/dpop";
import { encodeDevProxyCommandEnvelope } from "../../../../packages/contracts";
import type { DevProxyCommandJob, Env } from "../../../../packages/contracts/types";
import { errorMessage, logger } from "../../../../packages/logger";
import type { components } from "../../../../packages/devproxy-client/api-types";
import { DpopReplay } from "./dpop-replay";
import { DEV_PROXY_MANIFEST } from "./manifest";
import { DEV_PROXY_PAGE } from "./page";

// The dev-proxy worker: a development application that runs in production, so a
// developer can exercise the real gateway → brain command path against real
// data with no separate dev environment or dev client.
//
// Its public HTTP ingress crosses two untrusted→edge gates before it will mint
// anything: (1) Cloudflare Access — the whole worker sits behind an Access
// application, and the Access JWT is verified cryptographically (cf-access
// guard); (2) DPoP — every command request carries a fresh sender-constrained,
// replay-protected proof from the browser's WebCrypto key. Only then does the
// worker mint an on-behalf-of identity-context token (sub = the Access user,
// carrying the DPoP jkt + session) and invoke the gateway's DevProxy service-
// binding entrypoint, which authorizes the app AND the user before running the
// ordinary command pre-flight. See README.md "Dev proxy".

export { DpopReplay };

// Strongly-consistent replay store backed by the DpopReplay Durable Object.
const replayStore = (env: Env): DpopReplayStore => ({
  seenBefore: (jti, ttlSeconds) => {
    const namespace = env.DPOP_REPLAY;
    if (!namespace) {
      // Fail closed: with no replay store we cannot guarantee single-use, so
      // treat every proof as already seen (deny).
      logger.warn("dpop_replay_store_missing", {});
      return Promise.resolve(true);
    }
    const stub = namespace.get(namespace.idFromName("dpop-replay"));
    return stub.seenBefore(jti, ttlSeconds);
  },
});

// Command request body. Kept deliberately narrow: the command name and options
// are the only client-supplied inputs; the acting subject, guild, application
// id, and interaction token are set by the worker from configuration, never by
// the caller.
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

const handleCommand = async (request: Request, env: Env): Promise<Response> => {
  // Gate 1: Cloudflare Access.
  const access = await cloudflareAccessGuard.verify(request, env);
  if (!access.ok) {
    return access.response;
  }

  // Gate 2: DPoP. The proof binds this exact method + URL and is single-use.
  const proof = request.headers.get("dpop");
  const dpop = await verifyDpopProof(
    proof,
    { htm: request.method, htu: request.url },
    replayStore(env),
  );
  if (!dpop.ok) {
    logger.warn("ingress_denied", {
      identity: "dpop",
      zone: "untrusted",
      transport: "http",
      outcome: "denied",
      reason: `dpop_${dpop.reason}`,
    });
    return json(401, { error: "unauthorized" });
  }

  // The acting Discord subject must be configured; without it the proxy has no
  // authorized identity to run as (fail closed).
  const subjectUserId = env.DEV_PROXY_SUBJECT;
  if (!subjectUserId) {
    return json(403, { error: "forbidden" });
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
    subjectUserId,
    subjectUsername: access.grant.identity.email ?? "dev-proxy",
    ...(env.DEV_PROXY_GUILD ? { guildId: env.DEV_PROXY_GUILD } : {}),
    ...(body.channelId ? { channelId: body.channelId } : {}),
    // A synthetic Discord application id + interaction token so deferred/enqueue
    // commands have credentials to carry; the async Discord edit targets the
    // real app but a synthetic token, so AI/D1/spend all run for testing while
    // the final Discord PATCH is a no-op. Inline commands round-trip fully.
    ...(env.DISCORD_APPLICATION_ID ? { applicationId: env.DISCORD_APPLICATION_ID } : {}),
    interactionToken: `devproxy:${crypto.randomUUID()}`,
    options: body.options ?? [],
  };

  try {
    const envelope = encodeDevProxyCommandEnvelope(job, {
      source: "worker",
      guildId: job.guildId,
    });
    // Mint the on-behalf-of token: sub is the Access-verified user, carrying the
    // DPoP jkt (sender constraint) and a jkt-derived session id for audit.
    const message = await serviceClients(env).devProxyToGateway.prepare(
      envelope,
      { sub: access.grant.identity.sub },
      { dpopJkt: dpop.jkt, sid: `s_${dpop.jkt.slice(0, 16)}` },
    );
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

    // The UI is itself behind Access; serving the page requires no DPoP (there
    // is nothing to sender-constrain yet — the page is what mints the key).
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(DEV_PROXY_PAGE, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (request.method === "POST" && url.pathname === "/api/command") {
      return handleCommand(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};
