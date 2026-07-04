import { WorkerEntrypoint } from "cloudflare:workers";

import { ensureRegistered } from "@rag/service-kit";
import { handleDevProxyCommand } from "../../../../lib/domain/devproxy";
import type { DevProxyResult } from "@rag/connectors/contracts";
import type { Env } from "../../../../contracts";
import type { ServiceMessageBytes } from "@rag/contracts-core";
import { GATEWAY_MANIFEST } from "./manifest";

// Service-binding RPC entrypoint for the dev-proxy worker. This is the gateway's
// ONLY service-boundary surface (its public surface is HTTP, described by
// openapi.yaml). A service binding is invocable solely by a worker configured
// with it, so this method is reachable only from apps/connectors/workers/dev-proxy — the
// platform guarantee that gates the dev application's hop. The heavy lifting
// (token verification, Cedar app + capability + per-user authorization, command
// dispatch) lives in handleDevProxyCommand so it is testable without a worker.
export class DevProxy extends WorkerEntrypoint<Env> {
  async invokeCommand(message: ServiceMessageBytes): Promise<DevProxyResult> {
    // Memoised per isolate; keeps the gateway's manifest (now advertising the
    // devproxy.command operation) registered for the registry-driven authorizer.
    await ensureRegistered(this.env, GATEWAY_MANIFEST);
    return handleDevProxyCommand(message, this.env, this.ctx);
  }
}
