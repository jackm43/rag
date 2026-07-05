import { WorkerEntrypoint } from "cloudflare:workers";

import type { EgressFetchInput, EgressResult } from "@rag/egress/contracts";
import type { Env } from "../../../contracts";
import { handleEgressRequest } from "@rag/egress/server";
export { EgressControl } from "./control";

// The egress sidecar. Reached only over the EGRESS service binding (trusted by
// capability), so it takes a plain EgressFetchInput — no signed envelope.
export class Egress extends WorkerEntrypoint<Env> {
  async fetchProfile(input: EgressFetchInput, body?: ArrayBuffer): Promise<EgressResult> {
    return handleEgressRequest(this.env, input, body);
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
};
