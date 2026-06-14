import { requireSenderConstraint } from "../resource/constraints";
import { connectorToken } from "../client/connector";
import type { ServiceCredential } from "../oauth2/exchange";
import { createDpopProof, generateDpopKey, type DpopKey } from "../oauth2/dpop";
import type { Identity } from "../identity";
import { errorMessage, logger } from "../logger";
import { principalFromIdentity } from "../identity";
import { annotateSpan, traceHeaders } from "../otel/context";
import { verifyStsToken, type StsVerifierConfig } from "../oauth2/sts";
import { bearerToken } from "./authenticators";
import { CLIENT_INSTANCE_HEADER, CLIENT_TOKEN_HEADER } from "../http/tokens";
import { createWorkerTransportFetch, serviceBindingFetch, type TransportMode } from "../transport";

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
  prefixes: string[];
  application: string;
  endpoint: string;
  scopes?: string[];
  bindingName?: string;
  fetch?: typeof fetch;
};

export type SessionProxyConfig = {
  application: string;
  gatewayUrl: string;
  credential: ServiceCredential;
  verify?: Partial<StsVerifierConfig>;
  transportMode?: TransportMode;
  // Transport for the exchange call (gateway service binding in workers).
  gatewayFetch?: typeof fetch;
  targets: ProxyTarget[];
};

export const proxyTargetFor = (
  audience: string,
  target: { endpoint: string; prefixes?: string[]; scopes?: string[]; bindingName?: string; fetch?: typeof fetch },
): ProxyTarget => ({
  prefixes: target.prefixes ?? [`/platform/${audience}/v1/`],
  application: audience,
  endpoint: target.endpoint,
  scopes: target.scopes,
  bindingName: target.bindingName,
  fetch: target.fetch,
});

const connectError = (status: number, code: string, message: string): Response =>
  new Response(JSON.stringify({ code, message }), {
    status,
    headers: { "content-type": "application/json" },
  });

// Per-client-instance header: a web page tags each logical client (e.g. one
// chat conversation) so the proxy keys its token cache per instance and the
// id shows up on every span along the request path.
export { CLIENT_INSTANCE_HEADER } from "../http/tokens";

const INSTANCE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
let proxyDpopKey: Promise<DpopKey> | null = null;

const dpopKey = (): Promise<DpopKey> => {
  proxyDpopKey ??= generateDpopKey();
  return proxyDpopKey;
};

export const clientInstance = (headers: Headers): string | null => {
  const value = headers.get(CLIENT_INSTANCE_HEADER);
  return value && INSTANCE_PATTERN.test(value) ? value : null;
};

export const verifyClientIdentityToken = async (
  config: { gatewayUrl: string; application: string; verify?: Partial<StsVerifierConfig> },
  token: string,
  session: Identity,
  instanceId?: string | null,
): Promise<Identity | null> => {
  const issuer = config.gatewayUrl.replace(/\/$/, "");
  const identity = await verifyStsToken(token, {
    issuer,
    audience: config.application,
    ...config.verify,
  });
  if (!identity || identity.subject !== session.subject) {
    return null;
  }
  if (instanceId && identity.clientInstance && identity.clientInstance !== instanceId) {
    return null;
  }
  return identity;
};

const chainIdentity = async (
  config: SessionProxyConfig,
  issuer: string,
  request: Request,
  session: Identity,
): Promise<Identity> => {
  const instance = clientInstance(request.headers);
  const clientToken = request.headers.get(CLIENT_TOKEN_HEADER);
  if (!clientToken) {
    return session;
  }
  const clientIdentity = await verifyClientIdentityToken(
    { gatewayUrl: issuer, application: config.application, verify: config.verify },
    clientToken,
    session,
    instance,
  );
  if (!clientIdentity) {
    return session;
  }
  return {
    ...session,
    ...clientIdentity,
    subjectToken: clientToken,
  };
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
    const target = config.targets.find((candidate) =>
      candidate.prefixes.some((prefix) => url.pathname.startsWith(prefix)),
    );
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
    const chainSubject = await chainIdentity(config, issuer, request, identity);
    const instance = chainSubject.clientInstance ?? clientInstance(request.headers);
    const principal = principalFromIdentity(chainSubject);
    annotateSpan({
      principal_kind: principal.kind,
      principal_sub: principal.sub,
      ...(principal.email ? { principal_email: principal.email } : {}),
      ...(principal.act ? { principal_act: principal.act.join(" > ") } : {}),
      target: target.application,
      ...(instance ? { client_instance: instance } : {}),
      ...(chainSubject.clientKind ? { client_kind: chainSubject.clientKind } : {}),
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
        chainSubject,
      );
    } catch (error) {
      logger.warn("request_denied", {
        method: url.pathname,
        target: target.application,
        actor: chainSubject.email ?? chainSubject.subject,
        reason: errorMessage(error),
      });
      return connectError(403, "permission_denied", errorMessage(error));
    }

    const upstream = new Request(
      `${target.endpoint.replace(/\/$/, "")}${url.pathname}${url.search}`,
      request,
    );
    upstream.headers.set("authorization", `Bearer ${access}`);
    upstream.headers.set(
      "dpop",
      await createDpopProof(await dpopKey(), { method: upstream.method, url: upstream.url }, access),
    );
    if (instance) {
      upstream.headers.set(CLIENT_INSTANCE_HEADER, instance);
    }
    for (const [key, value] of Object.entries(traceHeaders())) {
      upstream.headers.set(key, value);
    }
    const transportFetch = createWorkerTransportFetch(target.fetch, {
      mode: config.transportMode ?? "service-auth",
      caller: config.application,
      target: target.application,
      credential: config.credential,
      gatewayUrl: issuer,
      gatewayFetch: config.gatewayFetch,
    }, { requireBinding: Boolean(target.bindingName || target.fetch) });
    if (!transportFetch) {
      const label = target.bindingName ?? target.application;
      return connectError(503, "unavailable", `service binding ${label} is not configured`);
    }
    return transportFetch(upstream);
  };
};
