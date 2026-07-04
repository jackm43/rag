import { cloudflareAccessGuard } from "@rag/ingress/cf-access";
import { createClient } from "@rag/service-kit";
import { createEdgeWorker, jsonResponse } from "@rag/service-kit/edge";
import { connectorsClient } from "../../../../../lib";
import type { ConnectorResult, Env } from "../../../../../contracts";
import { errorMessage, logger } from "@rag/logger";
import { DEV_PROXY_MANIFEST } from "../../../../dev-proxy/service_server/src";
import { OPENAPI } from "./openapi";

// The connectors-api worker (connectors.jsmunro.me): the dedicated, MACHINE-
// facing HTTP surface over the credential broker. The broker (the Connectors
// entrypoint on ragbot-connectors-worker) stays binding-only — no route,
// workers_dev:false — reachable ONLY over the CONNECTORS service binding; this
// worker is its sole HTTP face for automation callers.
//
// Ingress is a single perimeter gate: Cloudflare Access on the whole hostname
// (createEdgeWorker's `guard`), verifying an Access grant — a service token or
// an Access JWT — for EVERYTHING, including /health and /openapi.json. Unlike
// the dev-proxy (the human admin surface at ragbot-dev.jsmunro.me), there is no
// Better Auth / Discord OAuth layer: a verified Access grant is a first-class
// machine identity, so the Access grant's subject IS the acting subject.
//
// On a connector op the worker invokes the broker over the CONNECTORS binding
// exactly as the dev-proxy does — the same connectorsClient framing the same
// connector.invoke envelope. The hop is minted as the `dev-proxy` MANAGEMENT
// principal over the "trusted" (capability-gated) binding transport: a service
// binding is invocable solely by a worker configured with it, so no signing key
// is needed, and `dev-proxy` is already the broker's authorized admin caller
// (apps/connectors/lib/registry.ts adminList/adminRead), so the connector.admin
// Cedar gate permits it with no broker-side change. The `service` label below is
// "connectors-api" (its own /health identity); the manifest it registers, and
// the identity it presents to the broker, are the shared dev-proxy management
// principal — this surface is a second face on that same management identity,
// not a new machine principal (adding one would require a new signing keyring
// entry).

// Map the broker's coarse fail-closed status to an HTTP status. Anything that is
// not a client-shaped denial the broker states (400/401/403/404) is relayed as a
// 502 upstream error — the broker never discloses why it refused. Mirrors the
// dev-proxy's relay so both HTTP faces answer identically.
const brokerHttpStatus = (status: number): number =>
  status === 200 || status === 400 || status === 401 || status === 403 || status === 404 ? status : 502;

// Relay a successful broker admin result (or its denial). `pick` selects the
// secret-free body to return; a non-200 broker status becomes a bare error.
const relay = (result: ConnectorResult, pick: (result: ConnectorResult) => unknown): Response =>
  result.status === 200 ? jsonResponse(200, pick(result)) : jsonResponse(brokerHttpStatus(result.status), { error: "broker_error" });

// GET /api/connectors: the read-only management listing. The perimeter guard has
// already verified Access; this re-resolves the grant to read the acting subject
// (the guard returns only pass/deny), then mints the on-behalf-of hop — sub is
// the Access identity — and invokes the broker's admin_list over the CONNECTORS
// binding, exactly as the dev-proxy's /api/connectors does.
const handleListConnectors = async (request: Request, env: Env): Promise<Response> => {
  if (!env.CONNECTORS) {
    logger.error("connectors_binding_missing", {});
    return jsonResponse(500, { error: "misconfigured" });
  }
  const access = await cloudflareAccessGuard.verify(request, env);
  if (!access.ok) {
    return access.response;
  }
  try {
    const client = connectorsClient(
      env,
      createClient({
        env,
        self: "dev-proxy",
        context: { subject: access.grant.identity.sub },
      }).to("connectors", { transportTrust: "trusted" }),
    );
    return relay(await client.listConnectors(), (result) => ({ connectors: result.connectors ?? [] }));
  } catch (error) {
    logger.error("connectors_list_failed", { error: errorMessage(error) });
    return jsonResponse(502, { error: "upstream_error" });
  }
};

export default createEdgeWorker<Env>({
  // The edge surface's own identity (its /health `service`). The broker hop it
  // makes is minted as the `dev-proxy` management principal — see the header.
  service: "connectors-api",
  manifest: DEV_PROXY_MANIFEST,
  openapi: OPENAPI,
  // Cloudflare Access is the perimeter for EVERYTHING on this hostname,
  // including health and openapi.
  guard: async (request, env) => {
    const access = await cloudflareAccessGuard.verify(request, env);
    return access.ok ? null : access.response;
  },
  routes: [
    {
      match: "/",
      methods: {
        GET: () =>
          new Response("ragbot connectors api", {
            headers: { "content-type": "text/plain; charset=utf-8" },
          }),
      },
    },
    {
      match: "/api/connectors",
      methods: {
        GET: (request, env) => handleListConnectors(request, env),
      },
    },
  ],
});
