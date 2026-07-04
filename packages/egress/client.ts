import { createClient, createHopIntent, SYSTEM_SUBJECT, type Subject, type VerifiedRequestContext } from "../auth";
import { encodeEgressRequestEnvelope } from "../contracts";
import type { Env, ServiceMessageBytes } from "../contracts/types";
import { envelopeSha256 } from "../identity";
import type { BoundaryFetch } from "../boundaries/outbound/boundary-client";

const STRIPPED_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);

export type EgressCaller = "responder" | "connectors" | "workflows" | "spend";

export type EgressFetchOptions = {
  subject?: Subject;
};

const prepareEgressMessage = (
  env: Env,
  caller: EgressCaller,
  context: VerifiedRequestContext,
  envelope: Uint8Array,
  intent: ReturnType<typeof createHopIntent>,
): Promise<ServiceMessageBytes> =>
  createClient({ env, self: caller, context })
    .to("egress", { transportTrust: "application", authorizeExchange: false })
    .prepare(envelope, { intent });

const clientContextOf = (subject: Subject | undefined): VerifiedRequestContext =>
  subject
    ? {
        subject: subject.sub,
        delegates: subject.delegates,
        requestId: subject.requestId,
        correlationId: subject.correlationId,
      }
    : { subject: SYSTEM_SUBJECT };

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

export const createEgressClient = (
  env: Env,
  profile: string,
  caller: EgressCaller,
): BoundaryFetch => {
  return async (input, init = {}, options?: EgressFetchOptions) => {
    if (!env.EGRESS) {
      throw new Error("EGRESS service binding is required for bound egress");
    }

    const request = await materializeRequest(input, init);
    const bodySha256 = request.body && request.body.byteLength > 0
      ? await envelopeSha256(new Uint8Array(request.body))
      : undefined;
    const envelope = encodeEgressRequestEnvelope(
      {
        kind: "egress.request",
        profile,
        method: request.method,
        url: request.url,
        headersJson: JSON.stringify(request.headers),
        ...(bodySha256 === undefined ? {} : { bodySha256 }),
      },
      { source: "worker" },
    );
    const message = await prepareEgressMessage(
      env,
      caller,
      clientContextOf(options?.subject),
      envelope,
      createHopIntent({
        action: "egress.request",
        resourceType: "EgressSidecar",
        resourceId: profile,
        method: request.method,
      }),
    );
    const result = await env.EGRESS.fetchProfile(message, request.body);
    return new Response(result.body, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
  };
};
