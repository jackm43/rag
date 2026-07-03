import { createServiceServer, registryEntities } from "../auth";
import { SYSTEM_SUBJECT, type MachinePrincipal } from "../auth/principal";
import type { RequestContext } from "../auth/context";
import { authorize } from "../authz/authorize";
import { createBoundaryClient, type BoundaryFetch } from "../boundaries/outbound/boundary-client";
import { decodeConnectorInvokeEnvelope } from "../contracts";
import type {
  ConnectorInvokeJob,
  ConnectorOperation,
  ConnectorResult,
  Env,
} from "../contracts/types";
import { errorMessage, logger } from "../logger";
import { sharedAccessTokenCache } from "./cache";
import { lookupConnector } from "./registry";
import {
  createGrantStore,
  createOAuthTokenStore,
  durableObjectKeyValueStore,
  generateHandle,
  type GrantStore,
  type OAuthTokenStore,
} from "./store";
import { strategyFor } from "./strategy";
import { ConnectorError, type ConnectorConfig, type GrantEntry, type StrategyContext } from "./types";

// The credential broker's ingress. Every operation runs the SAME fail-closed
// order, reusing the shared machinery rather than reinventing it:
//
//   1. createServiceServer verification — the identity-context token is verified
//      (Ed25519 signature, aud == connectors, iss in the caller allowlist,
//      exp/iat window, envelope-hash binding), the operation is checked against
//      the broker's one registered service operation (connector.invoke), and
//      Cedar service.invoke authorizes the delivery. This authenticates the
//      CALLING SERVICE.
//   2. Cedar connector.* — the per-connector capability gate against
//      Connector::<id> with the verified caller as the principal. A caller may
//      only touch a connector it is explicitly permitted (connectors.cedar).
//   3. (handle operations) handle binding — the grant is looked up and must have
//      been issued to THIS verified caller. A leaked handle is useless to anyone
//      else, and this is re-checked on every use.
//   4. Only then is a credential resolved (server-side), injected, and — for a
//      fetch — sent through the connector's host-allowlisted boundary client. The
//      real credential never leaves the broker on the fetch/introspect paths.
//
// Every use writes an audit log line carrying the full actor chain. Any failure
// returns a bare status (no detail) — denials never disclose which gate refused.

// The services whose tokens the broker will even attempt to verify. Cedar still
// gates every hop and every connector, so this is the crypto-layer allowlist,
// not the authorization. Add a caller here (and grant it in the policies) to let
// a new service use the broker.
const CONNECTOR_CALLERS: readonly MachinePrincipal[] = ["brain"];

const DEFAULT_TIMEOUT_MS = 15_000;

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

// Response headers safe to relay to the caller. Everything else (Set-Cookie,
// authenticate challenges, provider rate-limit internals) is dropped.
const SAFE_RESPONSE_HEADERS = new Set([
  "content-type",
  "content-length",
  "etag",
  "last-modified",
  "cache-control",
  "date",
  "link",
]);

const denied = (status: number): ConnectorResult => ({ status });

// The Cedar action each operation authorizes against Connector::<id>. introspect
// reuses connector.fetch (a read on the caller's own grant); begin/complete map
// to connector.authorize.
const CEDAR_ACTION: Record<ConnectorOperation, string> = {
  grant: "connector.grant",
  fetch: "connector.fetch",
  token: "connector.token",
  introspect: "connector.fetch",
  begin_authorization: "connector.authorize",
  complete_authorization: "connector.authorize",
};

const parseParams = (json: string): Record<string, unknown> => {
  if (json.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ConnectorError(400, "params_not_object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ConnectorError) {
      throw error;
    }
    throw new ConnectorError(400, "params_invalid_json");
  }
};

type FetchRequest = { method: string; path: string; headers: Record<string, string>; body?: string };

const parseFetchRequest = (params: Record<string, unknown>): FetchRequest => {
  const request = params.request;
  if (!request || typeof request !== "object") {
    throw new ConnectorError(400, "request_missing");
  }
  const r = request as Record<string, unknown>;
  const method = typeof r.method === "string" ? r.method.toUpperCase() : "GET";
  if (!ALLOWED_METHODS.has(method)) {
    throw new ConnectorError(400, "method_not_allowed");
  }
  if (typeof r.path !== "string" || !r.path.startsWith("/")) {
    throw new ConnectorError(400, "path_invalid");
  }
  const headers: Record<string, string> = {};
  if (r.headers && typeof r.headers === "object") {
    for (const [key, value] of Object.entries(r.headers as Record<string, unknown>)) {
      if (typeof value === "string") {
        headers[key] = value;
      }
    }
  }
  if (r.body !== undefined && typeof r.body !== "string") {
    throw new ConnectorError(400, "body_invalid");
  }
  return { method, path: r.path, headers, ...(typeof r.body === "string" ? { body: r.body } : {}) };
};

// Merge caller-supplied request headers with the strategy's credential injection,
// dropping any caller header that collides (case-insensitively) with an injected
// one so a caller can never override the credential it is not allowed to see.
const mergeHeaders = (requestHeaders: Record<string, string>, injection: Record<string, string>) => {
  const injectedKeys = new Set(Object.keys(injection).map((key) => key.toLowerCase()));
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(requestHeaders)) {
    if (!injectedKeys.has(key.toLowerCase())) {
      merged[key] = value;
    }
  }
  return { ...merged, ...injection };
};

const filterResponseHeaders = (headers: Headers): Record<string, string> => {
  const filtered: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (SAFE_RESPONSE_HEADERS.has(key.toLowerCase())) {
      filtered[key] = value;
    }
  });
  return filtered;
};

const connectorBoundary = (connector: ConnectorConfig): BoundaryFetch =>
  createBoundaryClient({
    identity: `connector-${connector.id}`,
    trustZone: "egress-connector",
    allowedHosts: [connector.host],
    defaultTimeoutMs: connector.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(connector.maxResponseBytes !== undefined ? { maxResponseBytes: connector.maxResponseBytes } : {}),
  });

const kvStore = (env: Env) => {
  if (!env.CONNECTOR_STORE) {
    throw new ConnectorError(500, "store_unbound");
  }
  return durableObjectKeyValueStore(env.CONNECTOR_STORE);
};

const grantStore = (env: Env): GrantStore => createGrantStore(kvStore(env));
const oauthStore = (env: Env): OAuthTokenStore =>
  createOAuthTokenStore(kvStore(env), env.CONNECTORS_TOKEN_ENC_KEY);

const strategyContext = (
  connector: ConnectorConfig,
  env: Env,
  subject: string,
  scopes: string[],
  params: Record<string, unknown>,
  fetch: BoundaryFetch,
): StrategyContext => ({
  connector,
  env,
  fetch,
  now: () => Date.now(),
  tokenCache: sharedAccessTokenCache(),
  oauthTokens: oauthStore(env),
  subject,
  scopes,
  params,
});

const authorizeConnector = async (
  caller: MachinePrincipal,
  operation: ConnectorOperation,
  connector: ConnectorConfig,
  env: Env,
): Promise<boolean> => {
  const decision = authorize(
    {
      principal: { type: "Machine", id: caller },
      action: CEDAR_ACTION[operation],
      resource: { type: "Connector", id: connector.cedarResource },
    },
    await registryEntities(env),
  );
  return decision.allowed;
};

const logDenied = (reason: string, fields: Record<string, unknown>) =>
  logger.warn("connector_denied", { outcome: "denied", reason, ...fields });

// The audit record on every use of a credential: the complete actor chain
// (calling principal + delegation chain + acting subject), the connector and the
// handle it was reached through, and the target + outcome.
const auditUse = (
  operation: ConnectorOperation,
  entry: GrantEntry,
  context: RequestContext,
  extra: Record<string, unknown>,
) =>
  logger.info("connector_use", {
    operation,
    connectorId: entry.connectorId,
    grantId: entry.handle,
    callerPrincipal: entry.callerPrincipal,
    delegates: context.delegates,
    subject: entry.subject,
    ...extra,
  });

// Resolve a handle to a grant, enforcing the phantom-token binding: the grant
// must exist, be unexpired, and have been issued to this verified caller.
const resolveGrant = async (
  handle: string,
  caller: MachinePrincipal,
  env: Env,
): Promise<GrantEntry | null> => {
  const entry = await grantStore(env).get(handle);
  if (!entry) {
    logDenied("handle_unknown_or_expired", { caller });
    return null;
  }
  if (entry.callerPrincipal !== caller) {
    // A handle presented by a service other than the one it was issued to.
    logDenied("handle_caller_mismatch", { caller, issuedTo: entry.callerPrincipal });
    return null;
  }
  return entry;
};

const handleGrant = async (
  job: ConnectorInvokeJob,
  caller: MachinePrincipal,
  env: Env,
): Promise<ConnectorResult> => {
  const connector = lookupConnector(job.connectorId);
  if (!connector) {
    logDenied("unknown_connector", { caller, connectorId: job.connectorId });
    return denied(404);
  }
  if (!(await authorizeConnector(caller, "grant", connector, env))) {
    logDenied("not_authorized", { caller, connectorId: connector.id, action: "connector.grant" });
    return denied(403);
  }
  const subject = job.subject ?? SYSTEM_SUBJECT;
  const scopes = job.scopes.length ? job.scopes : connector.defaultScopes ?? [];
  const params = parseParams(job.paramsJson);
  const ctx = strategyContext(connector, env, subject, scopes, params, connectorBoundary(connector));
  const prepared = await strategyFor(connector.kind).prepare(ctx);
  const handle = generateHandle();
  const now = Date.now();
  const entry: GrantEntry = {
    handle,
    connectorId: connector.id,
    callerPrincipal: caller,
    subject,
    scopes,
    params,
    createdAt: now,
    expiresAt: prepared.expiresAt * 1000,
  };
  await grantStore(env).put(entry);
  logger.info("connector_grant", {
    connectorId: connector.id,
    grantId: handle,
    callerPrincipal: caller,
    subject,
    scopes,
    expiresAt: entry.expiresAt,
  });
  return { status: 200, grant: { handle, connectorId: connector.id, expiresAt: entry.expiresAt } };
};

const handleFetch = async (
  job: ConnectorInvokeJob,
  caller: MachinePrincipal,
  context: RequestContext,
  env: Env,
): Promise<ConnectorResult> => {
  const entry = await resolveGrant(job.handle as string, caller, env);
  if (!entry) {
    return denied(404);
  }
  const connector = lookupConnector(entry.connectorId);
  if (!connector) {
    return denied(404);
  }
  if (!(await authorizeConnector(caller, "fetch", connector, env))) {
    logDenied("not_authorized", { caller, connectorId: connector.id, action: "connector.fetch" });
    return denied(403);
  }
  const request = parseFetchRequest(parseParams(job.paramsJson));
  const boundary = connectorBoundary(connector);
  const ctx = strategyContext(connector, env, entry.subject, entry.scopes, entry.params, boundary);
  const injection = await strategyFor(connector.kind).inject(ctx);
  let response: Response;
  try {
    response = await boundary(`https://${connector.host}${request.path}`, {
      method: request.method,
      headers: mergeHeaders(request.headers, injection),
      ...(request.body !== undefined ? { body: request.body } : {}),
    });
  } catch (error) {
    auditUse("fetch", entry, context, {
      host: connector.host,
      path: request.path,
      method: request.method,
      outcome: "upstream_error",
    });
    logger.warn("connector_fetch_failed", { connectorId: connector.id, error: errorMessage(error) });
    return denied(502);
  }
  const body = await response.text();
  auditUse("fetch", entry, context, {
    host: connector.host,
    path: request.path,
    method: request.method,
    status: response.status,
    outcome: "ok",
  });
  return {
    status: 200,
    fetch: { status: response.status, headers: filterResponseHeaders(response.headers), body },
  };
};

const handleToken = async (
  job: ConnectorInvokeJob,
  caller: MachinePrincipal,
  context: RequestContext,
  env: Env,
): Promise<ConnectorResult> => {
  const entry = await resolveGrant(job.handle as string, caller, env);
  if (!entry) {
    return denied(404);
  }
  const connector = lookupConnector(entry.connectorId);
  if (!connector) {
    return denied(404);
  }
  if (!(await authorizeConnector(caller, "token", connector, env))) {
    logDenied("not_authorized", { caller, connectorId: connector.id, action: "connector.token" });
    return denied(403);
  }
  const ctx = strategyContext(
    connector,
    env,
    entry.subject,
    entry.scopes,
    entry.params,
    connectorBoundary(connector),
  );
  const token = await strategyFor(connector.kind).token(ctx);
  auditUse("token", entry, context, { host: connector.host, outcome: "ok" });
  return {
    status: 200,
    token: {
      value: token.value,
      tokenType: token.tokenType,
      ...(token.expiresAt !== undefined ? { expiresAt: token.expiresAt } : {}),
    },
  };
};

const handleIntrospect = async (
  job: ConnectorInvokeJob,
  caller: MachinePrincipal,
  context: RequestContext,
  env: Env,
): Promise<ConnectorResult> => {
  const entry = await resolveGrant(job.handle as string, caller, env);
  if (!entry) {
    return denied(404);
  }
  const connector = lookupConnector(entry.connectorId);
  if (!connector) {
    return denied(404);
  }
  if (!(await authorizeConnector(caller, "introspect", connector, env))) {
    logDenied("not_authorized", { caller, connectorId: connector.id, action: "connector.fetch" });
    return denied(403);
  }
  auditUse("introspect", entry, context, { outcome: "ok" });
  return {
    status: 200,
    introspection: {
      active: entry.expiresAt > Date.now(),
      connectorId: entry.connectorId,
      callerPrincipal: entry.callerPrincipal,
      subject: entry.subject,
      scopes: entry.scopes,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
    },
  };
};

const handleAuthorization = async (
  job: ConnectorInvokeJob,
  caller: MachinePrincipal,
  env: Env,
): Promise<ConnectorResult> => {
  const connector = lookupConnector(job.connectorId);
  if (!connector) {
    logDenied("unknown_connector", { caller, connectorId: job.connectorId });
    return denied(404);
  }
  if (!(await authorizeConnector(caller, job.operation, connector, env))) {
    logDenied("not_authorized", { caller, connectorId: connector.id, action: "connector.authorize" });
    return denied(403);
  }
  const strategy = strategyFor(connector.kind);
  const subject = job.subject ?? SYSTEM_SUBJECT;
  const scopes = job.scopes.length ? job.scopes : connector.defaultScopes ?? [];
  const ctx = strategyContext(
    connector,
    env,
    subject,
    scopes,
    parseParams(job.paramsJson),
    connectorBoundary(connector),
  );
  if (job.operation === "begin_authorization") {
    if (!strategy.beginAuthorization) {
      throw new ConnectorError(400, "authorization_unsupported");
    }
    const begin = await strategy.beginAuthorization(ctx);
    logger.info("connector_authorize_begin", { connectorId: connector.id, callerPrincipal: caller, subject });
    return { status: 200, authorization: begin };
  }
  if (!strategy.completeAuthorization) {
    throw new ConnectorError(400, "authorization_unsupported");
  }
  await strategy.completeAuthorization(ctx);
  logger.info("connector_authorize_complete", { connectorId: connector.id, callerPrincipal: caller, subject });
  return { status: 200 };
};

export const handleConnectorInvoke = async (
  message: unknown,
  env: Env,
): Promise<ConnectorResult> => {
  // Step 1: verify + registration gate + Cedar service.invoke, over the binding.
  const server = createServiceServer({ self: "connectors", expectedIssuers: CONNECTOR_CALLERS, env });
  const received = await server.receive(message, decodeConnectorInvokeEnvelope, "binding");
  if (!received) {
    return denied(401);
  }
  const job = received.payload;
  const caller = received.context.source;
  try {
    switch (job.operation) {
      case "grant":
        return await handleGrant(job, caller, env);
      case "fetch":
        return await handleFetch(job, caller, received.context, env);
      case "token":
        return await handleToken(job, caller, received.context, env);
      case "introspect":
        return await handleIntrospect(job, caller, received.context, env);
      case "begin_authorization":
      case "complete_authorization":
        return await handleAuthorization(job, caller, env);
      default:
        return denied(400);
    }
  } catch (error) {
    if (error instanceof ConnectorError) {
      logDenied(error.reason, { caller, operation: job.operation });
      return denied(error.status);
    }
    logger.error("connector_invoke_failed", { operation: job.operation, error: errorMessage(error) });
    return denied(500);
  }
};
