import { WorkerEntrypoint } from "cloudflare:workers";

import { ensureRegistered } from "@rag/service-kit";
import { handleConnectorInvoke } from "../../../lib";
import type { ConnectorResult, Env } from "../../../contracts";
import type { ServiceMessageBytes } from "@rag/contracts-core";
import { ConnectorStore } from "./store";
import { CONNECTORS_MANIFEST } from "./manifest";

// The credential broker worker: hosts the Connectors service-binding entrypoint
// and the ConnectorStore Durable Object, and nothing else. It has no route and
// no queue — reachable only through the CONNECTORS binding a caller declares — so
// no internet-facing worker owns provider credentials. The entrypoint is a thin
// shell: all verification (identity token, registration gate, Cedar service.invoke
// then connector.*), credential resolution, egress, and audit logging live in
// handleConnectorInvoke so they are testable without a worker.
export class Connectors extends WorkerEntrypoint<Env> {
  async invoke(message: ServiceMessageBytes): Promise<ConnectorResult> {
    // Memoised per isolate; keeps the broker's manifest registered for the
    // registry-driven authorizer.
    await ensureRegistered(this.env, CONNECTORS_MANIFEST);
    return handleConnectorInvoke(message, this.env);
  }
}

export { ConnectorStore };

export default {
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
};
