import { WorkerEntrypoint } from "cloudflare:workers";

import { ensureRegistered } from "@rag/service-kit";
import type { EgressResult } from "@rag/egress/contracts";
import type { Env } from "../../../contracts";
import type { ServiceMessageBytes } from "@rag/contracts-core";
import { handleEgressRequest } from "@rag/egress/server";
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
