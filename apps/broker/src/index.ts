import { WorkerEntrypoint } from "cloudflare:workers";

import { handleConnectorInvoke } from "@rag/connectors-core/lib";
import type { ConnectorInvokeJob, ConnectorResult, Env } from "@rag/connectors-core/contracts";
import { ConnectorStore } from "./store";

// The credential broker worker: hosts the Connectors service-binding entrypoint
// and the ConnectorStore Durable Object, and nothing else. It has no route and
// no queue — reachable only through the CONNECTORS binding a caller declares — so
// no internet-facing worker owns provider credentials. Trust is structural: only
// a worker whose wrangler declares the binding can call, so the caller arrives
// as a plain string (no signed token). Per-connector authorization, credential
// resolution, egress, and audit logging live in handleConnectorInvoke.
export class Connectors extends WorkerEntrypoint<Env> {
  async invoke(job: ConnectorInvokeJob, caller: string): Promise<ConnectorResult> {
    return handleConnectorInvoke(job, caller, this.env);
  }
}

export { ConnectorStore };

export default {
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
};
