import type { EgressEnv } from "@rag/egress/contracts";

// The egress sidecar's env: the EGRESS_CONTROL Durable Object (in EgressEnv) plus
// the credential vars/secrets the boundary client injects (Cloudflare.Env, from
// worker-configuration.d.ts). No service-registry / signing bindings remain.
export type Env = Cloudflare.Env & EgressEnv;
