import { requireSenderConstraint } from "../authz/constraints";
import { connectorToken } from "../client/connector";
import type { ServiceCredential } from "../client/exchange";
import type { Identity } from "../identity";
import { errorMessage, logger } from "../logger";
import { principalFromIdentity } from "../identity";
import { annotateSpan, traceHeaders } from "../otel";
import { verifyStsToken, type StsVerifierConfig } from "../verify/sts";
import { bearerToken } from "./authenticators";

// sessionProxy is the confidential web client (BFF) pattern: the web
// application is the registered principal for its pages. The browser stays a
// dumb public client (DPoP-bound session token + per-request proof); this
// proxy validates the sender constraint at the application's edge, chains the
// user's identity into an audience token for the target (subject = the user,
// actor = this application's service credential, gated by its delegations),
// injects it on the forwarded request, and streams the response back. One
// principal holds the tokens for every application it fronts; each target
// still validates the audience token itself.

export type ProxyTarget = {
  // Path prefix owned by this target, e.g. "/aigateway.v1." (Connect routes
  // are /<package>.<Service>/<Method>).
  prefix: string;
  // Target application name — the audience of the chained token.
  application: string;
  endpoint: string;
  scopes?: string[];
  // Service-binding fetch for the target (same-account worker-to-worker
  // fetches over public URLs are blocked).
  fetch?: typeof fetch;
};

export type SessionProxyConfig = {
  gatewayUrl: string;
  credential: ServiceCredential;
  verify?: Partial<StsVerifierConfig>;
  // Transport for the exchange call (gateway service binding in workers).
  gatewayFetch?: typeof fetch;
  targets: ProxyTarget[];
};

const connectError = (status: number, code: string, message: string): Response =>
  new Response(JSON.stringify({ code, message }), {
    status,
    headers: { "content-type": "application/json" },
  });

// Per-client-instance header: a web page tags each logical client (e.g. one
// chat conversation) so the proxy keys its token cache per instance and the
// id shows up on every span along the request path.
export const CLIENT_INSTANCE_HEADER = "x-client-instance";

const INSTANCE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const clientInstance = (headers: Headers): string | null => {
  const value = headers.get(CLIENT_INSTANCE_HEADER);
  return value && INSTANCE_PATTERN.test(value) ? value : null;
};

// verifySessionRequest authenticates a browser request at the application's
// edge: a DPoP-bound gateway session token plus a valid proof for this exact
// request. Shared by the proxy and any same-origin endpoints the worker adds
// (e.g. client/chat registration).
export const verifySessionRequest = async (
  config: { gatewayUrl: string; verify?: Partial<StsVerifierConfig> },
  request: Request,
): Promise<Identity | null> => {
  const token = bearerToken(request.headers);
  if (!token) {
    return null;
  }
  const issuer = config.gatewayUrl.replace(/\/$/, "");
  const session = await verifyStsToken(token, { issuer, audience: "idp", ...config.verify });
  if (!session?.cnfJkt) {
    return null;
  }
  const constrained = await requireSenderConstraint(session, request.headers, {
    method: request.method,
    url: request.url,
  });
  return constrained ? { ...constrained, subjectToken: token } : null;
};

export type SessionProxy = (request: Request) => Promise<Response | null>;

export const sessionProxy = (config: SessionProxyConfig): SessionProxy => {
  const issuer = config.gatewayUrl.replace(/\/$/, "");
  return async (request) => {
    const url = new URL(request.url);
    const target = config.targets.find((candidate) => url.pathname.startsWith(candidate.prefix));
    if (!target) {
      return null;
    }

    // Authenticate the user at the edge: only DPoP-bound gateway session
    // tokens with a valid proof for this exact request get through.
    const identity = await verifySessionRequest({ gatewayUrl: issuer, verify: config.verify }, request);
    if (!identity) {
      logger.warn("request_unauthenticated", { method: url.pathname, target: target.application });
      return connectError(401, "unauthenticated", "a DPoP-bound session token with a valid proof is required");
    }
    const instance = clientInstance(request.headers);
    const principal = principalFromIdentity(identity);
    annotateSpan({
      principal_kind: principal.kind,
      principal_sub: principal.sub,
      ...(principal.email ? { principal_email: principal.email } : {}),
      ...(principal.act ? { principal_act: principal.act.join(" > ") } : {}),
      target: target.application,
      ...(instance ? { client_instance: instance } : {}),
    });

    let access: string;
    try {
      access = await connectorToken(
        {
          application: target.application,
          endpoint: target.endpoint,
          gatewayUrl: issuer,
          credential: config.credential,
          scopes: target.scopes,
          partition: instance ?? undefined,
          gatewayFetch: config.gatewayFetch,
        },
        identity,
      );
    } catch (error) {
      logger.warn("request_denied", {
        method: url.pathname,
        target: target.application,
        actor: identity.email ?? identity.subject,
        reason: errorMessage(error),
      });
      return connectError(403, "permission_denied", errorMessage(error));
    }

    const upstream = new Request(
      `${target.endpoint.replace(/\/$/, "")}${url.pathname}${url.search}`,
      request,
    );
    upstream.headers.set("authorization", `Bearer ${access}`);
    upstream.headers.delete("dpop");
    for (const [key, value] of Object.entries(traceHeaders())) {
      upstream.headers.set(key, value);
    }
    return (target.fetch ?? globalThis.fetch.bind(globalThis))(upstream);
  };
};
