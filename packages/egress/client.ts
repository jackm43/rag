import type { EgressEnv, EgressFetchInput } from "./contracts";
import type { BoundaryFetch } from "./outbound/boundary-client";

type Env = EgressEnv;

const STRIPPED_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);

export type EgressCaller = "responder" | "connectors" | "workflows" | "spend";

// Retained for call-site compatibility; the subject is no longer signed into a
// token (egress is reached over a trusted, capability-gated binding), so it is
// currently unused. Kept so callers can pass it without churn.
export type EgressFetchOptions = {
  subject?: { sub: string };
};

const bodyAllowed = (method: string) => method !== "GET" && method !== "HEAD";

const materializeRequest = async (input: string | URL, init: RequestInit = {}) => {
  const method = (init.method ?? "GET").toUpperCase();
  const request = new Request(String(input), { ...init, method });
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    if (!STRIPPED_HEADERS.has(key)) {
      headers[key] = value;
    }
  });
  const body = bodyAllowed(method) ? await request.arrayBuffer() : undefined;
  return { method, url: request.url, headers, body };
};

// A `fetch`-shaped function that routes an outbound request through the egress
// sidecar over its service binding. Trust is structural: only a worker whose
// wrangler declares EGRESS can call, so the request is a plain object — no
// envelope, no identity token.
export const createEgressClient = (
  env: Env,
  profile: string,
  caller: EgressCaller,
): BoundaryFetch => {
  return async (input, init = {}, _options?: EgressFetchOptions) => {
    if (!env.EGRESS) {
      throw new Error("EGRESS service binding is required for bound egress");
    }
    const request = await materializeRequest(input, init);
    const fetchInput: EgressFetchInput = {
      caller,
      profile,
      method: request.method,
      url: request.url,
      headers: request.headers,
    };
    const result = await env.EGRESS.fetchProfile(fetchInput, request.body);
    return new Response(result.body, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
  };
};
