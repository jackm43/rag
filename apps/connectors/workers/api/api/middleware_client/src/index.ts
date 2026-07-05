import { createAppWorker, jsonResponse, type AuthGatewayBinding } from "@rag/edge-kit";
import { createClient } from "@rag/service-kit";
import { connectorsClient } from "@rag/connectors-core/lib";
import type { ConnectorResult, Env as ConnectorsEnv } from "@rag/connectors-core/contracts";
import { errorMessage, logger } from "@rag/logger";
import { OPENAPI } from "./openapi";

// The connectors-api worker (connectors.jsmunro.me): the machine-facing HTTP
// surface over the credential broker. Authentication is now centralized in the
// auth worker (the API Gateway): this worker binds AUTH and the shared edge
// middleware runs authenticate -> verify -> authorize before any handler. The
// broker (the Connectors entrypoint on ragbot-connectors-worker) stays
// binding-only; this worker is its sole HTTP face for automation callers.
//
// The native client kind covers this surface: the auth worker verifies the
// Cloudflare Access grant (service token or Access JWT) and returns the acting
// subject as the principal. Discovery (/health, /openapi.json) is public.

type Env = ConnectorsEnv & { AUTH: AuthGatewayBinding };

// Map the broker's coarse fail-closed status to an HTTP status. Anything that is
// not a client-shaped denial the broker states (400/401/403/404) is relayed as a
// 502 upstream error — the broker never discloses why it refused.
const brokerHttpStatus = (status: number): number =>
  status === 200 || status === 400 || status === 401 || status === 403 || status === 404 ? status : 502;

const relay = (result: ConnectorResult, pick: (result: ConnectorResult) => unknown): Response =>
  result.status === 200
    ? jsonResponse(200, pick(result))
    : jsonResponse(brokerHttpStatus(result.status), { error: "broker_error" });

// GET /api/connectors: the read-only management listing. The auth worker has
// already authenticated + authorized the caller; `subject` is the acting Access
// identity, used as the broker-hop subject.
const listConnectors = async (subject: string, env: Env): Promise<Response> => {
  if (!env.CONNECTORS) {
    logger.error("connectors_binding_missing", {});
    return jsonResponse(500, { error: "misconfigured" });
  }
  try {
    const client = connectorsClient(
      env,
      createClient({ env, self: "dev-proxy", context: { subject } }).to("connectors", { transportTrust: "trusted" }),
    );
    return relay(await client.listConnectors(), (result) => ({ connectors: result.connectors ?? [] }));
  } catch (error) {
    logger.error("connectors_list_failed", { error: errorMessage(error) });
    return jsonResponse(502, { error: "upstream_error" });
  }
};

export default createAppWorker<Env>({
  service: "connectors-api",
  openapi: OPENAPI,
  routes: [
    {
      method: "GET",
      path: "/api/connectors",
      operationId: "listConnectors",
      action: "connector.list",
      clientKind: "native",
      handler: ({ env, principal }) => listConnectors(principal.subject, env),
    },
  ],
});
