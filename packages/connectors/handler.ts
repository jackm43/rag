import { createServiceServer, registryEntities } from "../auth";
import { SYSTEM_SUBJECT, type MachinePrincipal } from "../auth/principal";
import type { RequestContext } from "../auth/context";
import { authorize } from "../authz/authorize";
import { createBoundaryClient, type BoundaryFetch } from "../boundaries/outbound/boundary-client";
import { decodeConnectorInvokeEnvelope } from "../contracts";
import type {
  ConnectorDetail,
  ConnectorInvokeJob,
  ConnectorOperation,
  ConnectorResult,
  ConnectorSummary,
  ConnectorWebhookVerification,
  Env,
  SetConnectorSecretResult,
} from "../contracts/types";
import { errorMessage, logger } from "../logger";
import {
  describeSecretsProviders,
  resolveSecretRef,
  secretsProvider,
  SECRETS_PROVIDER_NAMES,
  type SecretRef,
} from "../secrets";
import { sharedAccessTokenCache } from "./cache";
import { listAppInstallations } from "./providers/github";
import { CONNECTOR_REGISTRY, lookupConnector } from "./registry";
import {
  createConnectorConfigStore,
  createGrantStore,
  createOAuthStateStore,
  createOAuthTokenStore,
  durableObjectKeyValueStore,
  generateHandle,
  type ConnectorConfigStore,
  type GrantStore,
  type OAuthStateStore,
  type OAuthTokenStore,
} from "./store";
import { strategyFor } from "./strategy";
import { verifyWebhookSignature } from "./webhooks";
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
//
// `workflows` is the credential caller (grant/fetch/token). `dev-proxy` is the ADMIN
// caller: it reaches the `connector.admin.*` management ops (list, describe,
// set-secret, providers, installations) and drives the 3LO consent ceremony
// (connector.authorize) — it holds no `connector.grant/fetch/token` permit, so
// it cannot use a credential. `webhooks` is the webhook-ingress edge worker: it
// reaches ONLY `connector.webhook.verify` (a boolean out, never a secret), so a
// compromised receiver can verify signatures but never touch a credential.
const CONNECTOR_CALLERS: readonly MachinePrincipal[] = ["workflows", "dev-proxy", "webhooks"];

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

// The Cedar action each credential-facing operation authorizes against
// Connector::<id>. introspect reuses connector.fetch (a read on the caller's own
// grant); begin/complete map to connector.authorize; webhook_verify has its own
// action so the webhooks caller can be permitted verification and nothing else.
// The admin operations are gated separately (authorizeAdmin, connector.admin.*),
// so they are not here.
type CredentialOperation = Exclude<
  ConnectorOperation,
  "admin_list" | "admin_describe" | "admin_set_secret" | "admin_providers" | "admin_installations"
>;
const CEDAR_ACTION: Record<CredentialOperation, string> = {
  grant: "connector.grant",
  fetch: "connector.fetch",
  token: "connector.token",
  introspect: "connector.fetch",
  begin_authorization: "connector.authorize",
  complete_authorization: "connector.authorize",
  webhook_verify: "connector.webhook.verify",
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
const oauthStateStore = (env: Env): OAuthStateStore => createOAuthStateStore(kvStore(env));
const configStore = (env: Env): ConnectorConfigStore => createConnectorConfigStore(kvStore(env));

// Overlay any admin-set secret-reference override onto a connector's registry
// entry. The registry is immutable code; setConnectorSecret persists a
// {provider, ref} override in the config store, and EVERY credential-resolving
// path reads through this so the change actually takes effect (and survives).
// An absent override leaves the registry default untouched.
const effectiveConnector = async (connector: ConnectorConfig, env: Env): Promise<ConnectorConfig> => {
  const override = await configStore(env).getSecretRef(connector.id);
  return override ? { ...connector, secret: override } : connector;
};

// The flows a connector's kind supports, for the admin surface (informational —
// the per-op capability is still Cedar-gated). Derived from the strategy so the
// UI need not know kinds: every kind grants + fetches; api_key has no mintable
// token; a 3LO strategy adds authorize.
const connectorFlows = (connector: ConnectorConfig): string[] => {
  const strategy = strategyFor(connector.kind);
  const flows = ["grant", "fetch"];
  if (connector.kind !== "api_key") {
    flows.push("token");
  }
  if (strategy.beginAuthorization) {
    flows.push("authorize");
  }
  return flows;
};

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
  oauthStates: oauthStateStore(env),
  subject,
  scopes,
  params,
});

const authorizeConnector = async (
  caller: MachinePrincipal,
  operation: CredentialOperation,
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

// The broker-wide admin resource for ops that name no single connector (list
// connectors, list secrets backends). CONNECTOR_ID_PATTERN forbids "*", so this
// sentinel can never collide with a real connector's Cedar resource.
const BROKER_ADMIN_RESOURCE = "*";

// The per-op admin Cedar gate: authorize the verified caller for a
// `connector.admin.*` action against a Connector resource (a real connector's
// cedarResource for describe/set-secret, the broker-wide sentinel for list/
// providers). Fail closed exactly like authorizeConnector.
const authorizeAdmin = async (
  caller: MachinePrincipal,
  action: string,
  resourceId: string,
  env: Env,
): Promise<boolean> => {
  const decision = authorize(
    {
      principal: { type: "Machine", id: caller },
      action,
      resource: { type: "Connector", id: resourceId },
    },
    await registryEntities(env),
  );
  return decision.allowed;
};

// The audit record for a management operation. Carries the full actor chain and
// the operation's target, and NEVER a secret value (set-secret logs only the
// {provider, ref} locator and the coarse outcome).
const auditAdmin = (
  operation: ConnectorOperation,
  caller: MachinePrincipal,
  context: RequestContext,
  extra: Record<string, unknown>,
) =>
  logger.info("connector_admin", {
    operation,
    callerPrincipal: caller,
    delegates: context.delegates,
    subject: context.subject,
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
  const effective = await effectiveConnector(connector, env);
  const ctx = strategyContext(effective, env, subject, scopes, params, connectorBoundary(effective));
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
  const effective = await effectiveConnector(connector, env);
  const boundary = connectorBoundary(effective);
  const ctx = strategyContext(effective, env, entry.subject, entry.scopes, entry.params, boundary);
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
  const effective = await effectiveConnector(connector, env);
  const ctx = strategyContext(
    effective,
    env,
    entry.subject,
    entry.scopes,
    entry.params,
    connectorBoundary(effective),
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
  // Dispatch only routes begin/complete here, both mapping to connector.authorize.
  if (!(await authorizeConnector(caller, job.operation as CredentialOperation, connector, env))) {
    logDenied("not_authorized", { caller, connectorId: connector.id, action: "connector.authorize" });
    return denied(403);
  }
  const strategy = strategyFor(connector.kind);
  const subject = job.subject ?? SYSTEM_SUBJECT;
  const scopes = job.scopes.length ? job.scopes : connector.defaultScopes ?? [];
  const effective = await effectiveConnector(connector, env);
  const ctx = strategyContext(
    effective,
    env,
    subject,
    scopes,
    parseParams(job.paramsJson),
    connectorBoundary(effective),
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

// The webhook_verify request body (rides in paramsJson). The body travels as
// base64 because signatures are computed over EXACT bytes — any re-encoding at
// the receiver would silently break verification.
type WebhookVerifyInput = {
  provider: string;
  signatureHeaders: Record<string, string>;
  body: Uint8Array;
};

const parseWebhookVerify = (params: Record<string, unknown>): WebhookVerifyInput => {
  const { provider, signatureHeaders, bodyBase64 } = params;
  if (typeof provider !== "string" || provider.length === 0) {
    throw new ConnectorError(400, "webhook_provider_invalid");
  }
  if (!signatureHeaders || typeof signatureHeaders !== "object" || Array.isArray(signatureHeaders)) {
    throw new ConnectorError(400, "webhook_headers_invalid");
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(signatureHeaders as Record<string, unknown>)) {
    if (typeof value === "string") {
      headers[key] = value;
    }
  }
  if (typeof bodyBase64 !== "string") {
    throw new ConnectorError(400, "webhook_body_invalid");
  }
  let binary: string;
  try {
    binary = atob(bodyBase64);
  } catch {
    throw new ConnectorError(400, "webhook_body_invalid");
  }
  const body = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    body[index] = binary.charCodeAt(index);
  }
  return { provider, signatureHeaders: headers, body };
};

// Verify an inbound webhook's signature for the webhooks edge worker. The same
// fail-closed order as every credential op — Cedar connector.webhook.verify,
// then the connector's webhook config must exist and be enabled, then the
// caller-passed provider must EQUAL the configured one (the URL path segment on
// the receiver is routing sugar; this config is authoritative) — before the
// secret is resolved and the provider's HMAC scheme computed (webhooks.ts,
// constant-time). The caller receives only { valid, eventId? }; the secret, the
// digest, and the body never leave the broker, and none of them is logged.
const handleWebhookVerify = async (
  job: ConnectorInvokeJob,
  caller: MachinePrincipal,
  context: RequestContext,
  env: Env,
): Promise<ConnectorResult> => {
  const connector = lookupConnector(job.connectorId);
  if (!connector) {
    logDenied("unknown_connector", { caller, connectorId: job.connectorId });
    return denied(404);
  }
  if (!(await authorizeConnector(caller, "webhook_verify", connector, env))) {
    logDenied("not_authorized", { caller, connectorId: connector.id, action: "connector.webhook.verify" });
    return denied(403);
  }
  const webhook = connector.webhook;
  if (!webhook || !webhook.enabled) {
    logDenied("webhook_not_configured", { caller, connectorId: connector.id });
    return denied(404);
  }
  const input = parseWebhookVerify(parseParams(job.paramsJson));
  if (input.provider !== webhook.provider) {
    // The receiver's URL said one scheme, the connector is configured for
    // another. Never verify under the caller's choice of scheme — fail closed.
    logDenied("webhook_provider_mismatch", { caller, connectorId: connector.id });
    return denied(403);
  }
  // The secret-resolution gate, same as every strategy: an unresolvable webhook
  // secret denies rather than "verifying" against an empty key.
  const secret = await resolveSecretRef(env, webhook.secret);
  if (!secret) {
    logDenied(`webhook_secret_unresolved:${webhook.secret.provider}`, { caller, connectorId: connector.id });
    return denied(500);
  }
  const verification = await verifyWebhookSignature({
    provider: webhook.provider,
    secret,
    signatureHeaders: input.signatureHeaders,
    body: input.body,
  });
  // The audit line carries the actor chain and the coarse outcome — never the
  // secret, the digest, or the body.
  logger.info("connector_webhook_verify", {
    operation: "webhook_verify",
    connectorId: connector.id,
    provider: webhook.provider,
    callerPrincipal: caller,
    delegates: context.delegates,
    subject: context.subject,
    valid: verification.valid,
  });
  const webhookResult: ConnectorWebhookVerification = {
    valid: verification.valid,
    ...(verification.eventId !== undefined ? { eventId: verification.eventId } : {}),
  };
  return { status: 200, webhook: webhookResult };
};

// Build a connector's admin summary from its registry entry plus any secret-ref
// override: the config-level facts, and whether the referenced secret currently
// resolves (a boolean — NEVER the value). `override` is read once by the caller.
const buildSummary = async (
  connector: ConnectorConfig,
  override: SecretRef | null,
  env: Env,
): Promise<ConnectorSummary> => {
  const secret = override ?? connector.secret;
  return {
    id: connector.id,
    kind: connector.kind,
    host: connector.host,
    flows: connectorFlows(connector),
    // Resolve the reference server-side to report status; the value is discarded.
    secretConfigured: (await resolveSecretRef(env, secret)) !== null,
    secretProvider: secret.provider,
  };
};

const handleAdminList = async (
  caller: MachinePrincipal,
  context: RequestContext,
  env: Env,
): Promise<ConnectorResult> => {
  if (!(await authorizeAdmin(caller, "connector.admin.list", BROKER_ADMIN_RESOURCE, env))) {
    logDenied("not_authorized", { caller, action: "connector.admin.list" });
    return denied(403);
  }
  const store = configStore(env);
  const connectors = await Promise.all(
    CONNECTOR_REGISTRY.map(async (connector) =>
      buildSummary(connector, await store.getSecretRef(connector.id), env),
    ),
  );
  auditAdmin("admin_list", caller, context, { count: connectors.length });
  return { status: 200, connectors };
};

const handleAdminDescribe = async (
  job: ConnectorInvokeJob,
  caller: MachinePrincipal,
  context: RequestContext,
  env: Env,
): Promise<ConnectorResult> => {
  const connector = lookupConnector(job.connectorId);
  if (!connector) {
    logDenied("unknown_connector", { caller, connectorId: job.connectorId });
    return denied(404);
  }
  if (!(await authorizeAdmin(caller, "connector.admin.read", connector.cedarResource, env))) {
    logDenied("not_authorized", { caller, connectorId: connector.id, action: "connector.admin.read" });
    return denied(403);
  }
  const override = await configStore(env).getSecretRef(connector.id);
  const summary = await buildSummary(connector, override, env);
  const detail: ConnectorDetail = {
    ...summary,
    cedarResource: connector.cedarResource,
    secretRef: (override ?? connector.secret).ref,
    secretOverridden: override !== null,
  };
  auditAdmin("admin_describe", caller, context, { connectorId: connector.id });
  return { status: 200, connector: detail };
};

const handleAdminProviders = async (
  caller: MachinePrincipal,
  context: RequestContext,
  env: Env,
): Promise<ConnectorResult> => {
  if (!(await authorizeAdmin(caller, "connector.admin.list", BROKER_ADMIN_RESOURCE, env))) {
    logDenied("not_authorized", { caller, action: "connector.admin.list" });
    return denied(403);
  }
  const providers = describeSecretsProviders(env);
  auditAdmin("admin_providers", caller, context, { count: providers.length });
  return { status: 200, providers };
};

// The set-secret request body (rides in paramsJson). `value` flows inward only;
// `ref` is the backend locator. A value with no ref is refused (there is nowhere
// to write it), and neither present is a no-op refusal — fail closed on both.
type SetSecretInput = { provider: string; ref: string; value?: string };

const parseSetSecret = (params: Record<string, unknown>): SetSecretInput => {
  const { provider, ref, value } = params;
  if (typeof provider !== "string" || !(SECRETS_PROVIDER_NAMES as readonly string[]).includes(provider)) {
    throw new ConnectorError(400, "provider_invalid");
  }
  if (ref !== undefined && (typeof ref !== "string" || ref.length === 0 || ref.length > 512)) {
    throw new ConnectorError(400, "ref_invalid");
  }
  if (value !== undefined && (typeof value !== "string" || value.length === 0 || value.length > 64 * 1024)) {
    throw new ConnectorError(400, "value_invalid");
  }
  if (ref === undefined && value === undefined) {
    throw new ConnectorError(400, "no_secret_input");
  }
  if (value !== undefined && ref === undefined) {
    // A value needs a locator to be written to; re-pointing needs a ref too.
    throw new ConnectorError(400, "ref_required_for_value");
  }
  return { provider, ref: ref as string, ...(typeof value === "string" ? { value } : {}) };
};

// Write or (re)point a connector's secret. This is where the per-backend runtime
// write-capability differences live and are surfaced HONESTLY — a backend that
// cannot be written at runtime never fakes success:
//   • runtime-writable + configured (hashicorp-vault, onepassword): write the
//     value, re-point the connector -> `written`.
//   • read-only-at-runtime (cloudflare-secret-store): re-point the connector but
//     do NOT write -> `provision_required`, with the exact ref to set via the CF
//     control plane.
//   • deploy-time-only (wrangler-env) with a value: refuse, persist nothing ->
//     `rejected` (set it with `wrangler secret put` and redeploy).
//   • ref only (no value): re-point to an out-of-band-provisioned secret ->
//     `referenced` (or `provision_required` if it does not resolve yet).
// The secret value is NEVER echoed back or logged.
const handleAdminSetSecret = async (
  job: ConnectorInvokeJob,
  caller: MachinePrincipal,
  context: RequestContext,
  env: Env,
): Promise<ConnectorResult> => {
  const connector = lookupConnector(job.connectorId);
  if (!connector) {
    logDenied("unknown_connector", { caller, connectorId: job.connectorId });
    return denied(404);
  }
  if (!(await authorizeAdmin(caller, "connector.admin.write", connector.cedarResource, env))) {
    logDenied("not_authorized", { caller, connectorId: connector.id, action: "connector.admin.write" });
    return denied(403);
  }
  const { provider, ref, value } = parseSetSecret(parseParams(job.paramsJson));
  const secretRef: SecretRef = { provider, ref };
  const backend = secretsProvider(env, provider);
  const info = describeSecretsProviders(env).find((entry) => entry.name === provider);
  const writable = typeof backend.set === "function";
  const configured = info?.configured ?? false;

  const emit = (fields: Omit<SetConnectorSecretResult, "connectorId" | "provider" | "ref">): ConnectorResult => {
    const secret: SetConnectorSecretResult = { connectorId: connector.id, provider, ref, ...fields };
    // Audit the locator + coarse outcome only — never the value.
    auditAdmin("admin_set_secret", caller, context, {
      connectorId: connector.id,
      provider,
      ref,
      hadValue: value !== undefined,
      outcome: secret.status,
    });
    return { status: 200, secret };
  };
  const persist = () => configStore(env).setSecretRef(connector.id, secretRef);
  const resolvesNow = async () => (await resolveSecretRef(env, secretRef)) !== null;

  if (value !== undefined) {
    // Deploy-time-only backend: a runtime value has nowhere to go. Refuse.
    if (provider === "wrangler-env") {
      return emit({
        status: "rejected",
        secretConfigured: false,
        detail:
          `wrangler-env is deploy-time only. Run \`wrangler secret put ${ref} ` +
          "-c workers/services/connectors/wrangler.jsonc` and redeploy; it is not settable at runtime.",
      });
    }
    // Read-only-at-runtime backend: re-point, but do not fake a write.
    if (!writable) {
      await persist();
      return emit({
        status: "provision_required",
        secretConfigured: await resolvesNow(),
        detail:
          `${provider} cannot be written at runtime. Provision secret "${ref}" out-of-band ` +
          "(e.g. the Cloudflare Secrets Store control plane); the connector is now pointed at it.",
      });
    }
    // Runtime-writable but unconfigured: refuse rather than throw opaquely.
    if (!configured) {
      return emit({
        status: "rejected",
        secretConfigured: false,
        detail: `${provider} is not configured on the broker (missing address/token).`,
      });
    }
    // Runtime-writable + configured: write the value, then re-point.
    try {
      await backend.set?.(ref, value);
    } catch (error) {
      logger.warn("connector_secret_write_failed", { connectorId: connector.id, provider, error: errorMessage(error) });
      return emit({ status: "rejected", secretConfigured: false, detail: `write to ${provider} failed` });
    }
    await persist();
    return emit({ status: "written", secretConfigured: await resolvesNow(), detail: `secret written to ${provider}` });
  }

  // Ref-only: re-point to an out-of-band-provisioned secret.
  await persist();
  const secretConfigured = await resolvesNow();
  return emit({
    status: secretConfigured ? "referenced" : "provision_required",
    secretConfigured,
    detail: secretConfigured
      ? `connector re-pointed to ${provider}:${ref}`
      : `connector re-pointed to ${provider}:${ref}, but it does not resolve yet — provision the secret there`,
  });
};

// List a github_app connector's App installations for the admin surface (the
// reserved GET /api/connectors/{id}/installations endpoint). Gated under the
// existing connector.admin.read action — it discloses configuration-level facts
// (which accounts installed the App), not a credential. The App JWT is minted
// and used entirely broker-side (providers/github.ts listAppInstallations); the
// caller receives only the trimmed {id, accountLogin, repositorySelection} list.
const handleAdminInstallations = async (
  job: ConnectorInvokeJob,
  caller: MachinePrincipal,
  context: RequestContext,
  env: Env,
): Promise<ConnectorResult> => {
  const connector = lookupConnector(job.connectorId);
  if (!connector) {
    logDenied("unknown_connector", { caller, connectorId: job.connectorId });
    return denied(404);
  }
  if (!(await authorizeAdmin(caller, "connector.admin.read", connector.cedarResource, env))) {
    logDenied("not_authorized", { caller, connectorId: connector.id, action: "connector.admin.read" });
    return denied(403);
  }
  if (connector.kind !== "github_app") {
    // Installations are a GitHub App concept; any other kind has none to list.
    throw new ConnectorError(400, "installations_unsupported");
  }
  const effective = await effectiveConnector(connector, env);
  const installations = await listAppInstallations(env, effective, connectorBoundary(effective));
  auditAdmin("admin_installations", caller, context, {
    connectorId: connector.id,
    count: installations.length,
  });
  return { status: 200, installations };
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
      case "webhook_verify":
        return await handleWebhookVerify(job, caller, received.context, env);
      case "admin_list":
        return await handleAdminList(caller, received.context, env);
      case "admin_describe":
        return await handleAdminDescribe(job, caller, received.context, env);
      case "admin_set_secret":
        return await handleAdminSetSecret(job, caller, received.context, env);
      case "admin_providers":
        return await handleAdminProviders(caller, received.context, env);
      case "admin_installations":
        return await handleAdminInstallations(job, caller, received.context, env);
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
