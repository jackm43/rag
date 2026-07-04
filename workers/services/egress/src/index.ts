import { WorkerEntrypoint } from "cloudflare:workers";

import { ensureRegistered } from "../../../../packages/auth";
import type { EgressResult, Env, ServiceMessageBytes } from "../../../../packages/contracts/types";
import { handleEgressRequest } from "../../../../packages/egress/server";
import { EGRESS_MANIFEST } from "./manifest";
export { EgressControl } from "./control";

export class Egress extends WorkerEntrypoint<Env> {
  async fetchProfile(message: ServiceMessageBytes, body?: ArrayBuffer): Promise<EgressResult> {
    await ensureRegistered(this.env, EGRESS_MANIFEST);
    return handleEgressRequest(this.env, message, body);
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
};
