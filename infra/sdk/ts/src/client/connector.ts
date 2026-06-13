import { createClient as createConnectClient, type Client, type Interceptor, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import type { DescService } from "@bufbuild/protobuf";

import { verifyMintedToken } from "../resource/minted";
import type { Identity } from "../identity";
import { errorMessage, logger } from "../logger";
import { traceHeaders } from "../otel";
import { ttlCache } from "./cache";
import { chainExchange, loadServiceCredentialFromEnv, type ServiceCredential } from "../oauth2/exchange";
import { createClient, type PlatformClient } from "./fetch";

// A connector is the standard outbound integration with another trust zone
// application on behalf of the calling user: the outbound interceptor (the
// client's token source) authenticates the caller, exchanges the caller's
// subject token for an audience token naming the next hop (this service's
// credential as actor, so the chain is recorded), validates the minted token
// against the caller's identity, and attaches it to the service-to-service
// request. Any failure stops the request before it leaves.

export type ConnectorConfig = {
  // Target application name — the audience of the chained token and the next
  // hop in the delegation chain (requires a registered delegation).
  application: string;
  // Target base URL; workers also pass the service-binding fetch below.
  endpoint: string;
  gatewayUrl: string;
  credential: ServiceCredential;
  scopes?: string[];
  // Isolates token caching per logical client instance (e.g. one chat
  // conversation): same user, same audience, separate minted tokens.
  partition?: string;
  // Transport for the exchange call (gateway service binding in workers).
  gatewayFetch?: typeof fetch;
  // Transport for the target application (its service binding in workers).
  fetch?: typeof fetch;
};

export class ConnectorAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorAuthError";
  }
}

// Chained tokens are cached per (audience, subject token) until near expiry,
// shared across connector instances since clients are built per request.
const tokenCache = ttlCache<string>();

// connectorToken authenticates the caller and mints the chained audience
// token for one outbound hop; exported for proxies that inject the token on
// forwarded requests rather than making their own RPCs.
export const connectorToken = async (config: ConnectorConfig, identity: Identity): Promise<string> => {
  if (!identity.subjectToken) {
    throw new ConnectorAuthError(
      `connector ${config.application}: caller identity cannot chain (no subject token)`,
    );
  }
  const key = `${config.partition ?? ""}:${config.application}:${identity.subjectToken}`;
  const cached = tokenCache.get(key);
  if (cached) {
    return cached;
  }
  const minted = await chainExchange(
    config.gatewayUrl,
    identity.subjectToken,
    config.credential,
    config.application,
    config.scopes,
    config.gatewayFetch,
  );
  if (!minted) {
    throw new ConnectorAuthError(
      `connector ${config.application}: token exchange refused for ${identity.email ?? identity.subject}`,
    );
  }
  // Fail closed unless the gateway minted exactly what this request needs: a
  // fully verified token for the target audience whose actor chain is a
  // currently-delegated path and that still names the caller as subject.
  const verified = await verifyMintedToken(
    minted.accessToken,
    {
      issuer: config.gatewayUrl.replace(/\/$/, ""),
      audience: config.application,
      gatewayFetch: config.gatewayFetch,
      serviceCredential: config.credential,
    },
    identity.subject,
  );
  if (!verified) {
    throw new ConnectorAuthError(
      `connector ${config.application}: minted token does not match caller identity`,
    );
  }
  tokenCache.set(key, minted.accessToken, minted.expiresIn);
  return minted.accessToken;
};

// connectorClient builds the per-caller outbound client for a connector.
const connectorClient = (config: ConnectorConfig, identity: Identity): PlatformClient =>
  createClient({
    endpoint: config.endpoint,
    fetch: config.fetch,
    token: () => connectorToken(config, identity),
    decorate: (headers) => {
      for (const [key, value] of Object.entries(traceHeaders())) {
        headers.set(key, value);
      }
    },
  });

// connectorTransport is the Connect transport every generated service client
// is built on. The instrumentation is part of the transport, not the
// generated or hand-written layer: outbound boundary crossings are logged
// (request, status, duration, actor) and the trace context propagates, so
// codegen output and applications never re-implement it.
const connectorTransport = (config: ConnectorConfig, identity: Identity): Transport => {
  const platform = connectorClient(config, identity);
  const boundary: Interceptor = (next) => async (req) => {
    const method = `${req.service.typeName}/${req.method.name}`;
    const actor = identity.email ?? identity.subject;
    const start = Date.now();
    try {
      const response = await next(req);
      logger.info("rpc_client", {
        application: config.application,
        method,
        actor,
        duration_ms: Date.now() - start,
      });
      return response;
    } catch (error) {
      logger.warn("rpc_client_failed", {
        application: config.application,
        method,
        actor,
        duration_ms: Date.now() - start,
        error: errorMessage(error),
      });
      throw error;
    }
  };
  return createConnectTransport({
    baseUrl: config.endpoint.replace(/\/$/, ""),
    // Workers fetch rejects connect-web's redirect: "error" option.
    fetch: ((input, init) =>
      platform.fetch(String(input), { ...init, redirect: undefined })) as typeof fetch,
    interceptors: [boundary],
  });
};

// connectorServiceClient binds a generated Connect service to a connector
// transport; generated per-application service clients are thin wrappers
// over this.
export const connectorServiceClient = <S extends DescService>(
  config: ConnectorConfig,
  identity: Identity,
  service: S,
): Client<S> => createConnectClient(service, connectorTransport(config, identity));

type ServiceBinding = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export type ServiceConnectionEnv = {
  AUTH_GATEWAY_URL?: string;
  SERVICE_CLIENT_ID?: string;
  SERVICE_CLIENT_SECRET?: string | { get(): Promise<string> };
  AUTH_GATEWAY?: ServiceBinding;
};

export type ServiceConnectionTarget = {
  endpoint?: string;
  // Target's service binding; same-account worker-to-worker fetches over
  // public URLs are blocked.
  binding?: ServiceBinding;
  scopes?: string[];
};

// serviceConnection is the one way a worker wires an outbound connector: its
// own service credential and gateway binding from the environment plus the
// target's endpoint/binding. Returns null until the credential and endpoint
// are configured (first-deploy ordering), so callers can fail closed.
export const serviceConnection = async (
  env: ServiceConnectionEnv,
  target: ServiceConnectionTarget,
): Promise<Omit<ConnectorConfig, "application"> | null> => {
  const credential = await loadServiceCredentialFromEnv(env);
  if (!credential || !target.endpoint) {
    return null;
  }
  return {
    endpoint: target.endpoint,
    gatewayUrl: (env.AUTH_GATEWAY_URL ?? "").replace(/\/$/, ""),
    credential,
    scopes: target.scopes,
    gatewayFetch: env.AUTH_GATEWAY
      ? (input, init) => env.AUTH_GATEWAY!.fetch(input, init)
      : undefined,
    fetch: target.binding ? (input, init) => target.binding!.fetch(input, init) : undefined,
  };
};
