import type { Identity } from "../identity";
import { errorMessage, logger } from "../logger";
import { traceHeaders } from "../otel/context";
import { ttlCache } from "./cache";
import { chainExchange, loadServiceCredentialFromEnv, type ServiceCredential } from "../oauth2/exchange";
import { generateDpopKey, type DpopKey } from "../oauth2/dpop";
import { createClient, type PlatformClient } from "./fetch";
import { verifyMintedToken } from "../resource/minted";
import {
  applicationFromEnv,
  createWorkerTransportFetch,
  serviceBindingFetch,
  transportModeFromEnv,
  type TransportMode,
} from "../transport";

export type ConnectorConfig = {
  application: string;
  endpoint: string;
  gatewayUrl: string;
  credential: ServiceCredential;
  scopes?: string[];
  partition?: string;
  caller?: string;
  transportMode?: TransportMode;
  gatewayFetch?: typeof fetch;
  fetch?: typeof fetch;
};

export class ConnectorAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorAuthError";
  }
}

const tokenCache = ttlCache<string>();
let connectorDpopKey: Promise<DpopKey> | null = null;

const dpopKey = (): Promise<DpopKey> => {
  connectorDpopKey ??= generateDpopKey();
  return connectorDpopKey;
};

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

const connectorClient = async (config: ConnectorConfig, identity: Identity): Promise<PlatformClient> => {
  const transportFetch = createWorkerTransportFetch(config.fetch, {
    mode: config.transportMode ?? "service-auth",
    caller: config.caller ?? "",
    target: config.application,
    credential: config.credential,
    gatewayUrl: config.gatewayUrl,
    gatewayFetch: config.gatewayFetch,
  }, { requireBinding: Boolean(config.fetch) });
  return createClient({
    endpoint: config.endpoint,
    fetch: transportFetch,
    token: () => connectorToken(config, identity),
    dpop: await dpopKey(),
    decorate: (headers) => {
      for (const [key, value] of Object.entries(traceHeaders())) {
        headers.set(key, value);
      }
    },
  });
};

export const connectorFetch = async (
  config: ConnectorConfig,
  identity: Identity,
  input: string,
  init?: RequestInit,
): Promise<Response> => {
  const method = `${config.application} ${init?.method ?? "GET"} ${input}`;
  const actor = identity.email ?? identity.subject;
  const start = Date.now();
  try {
    const client = await connectorClient(config, identity);
    const response = await client.fetch(input, init);
    logger.info("http_client", {
      application: config.application,
      method,
      actor,
      status: response.status,
      duration_ms: Date.now() - start,
    });
    return response;
  } catch (error) {
    logger.warn("http_client_failed", {
      application: config.application,
      method,
      actor,
      duration_ms: Date.now() - start,
      error: errorMessage(error),
    });
    throw error;
  }
};

type ServiceBinding = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export type ServiceConnectionEnv = {
  AUTH_GATEWAY_URL?: string;
  SERVICE_CLIENT_ID?: string;
  SERVICE_CLIENT_SECRET?: string | { get(): Promise<string> };
  AUTH_GATEWAY?: ServiceBinding;
  OTEL_SERVICE_NAME?: string;
  PLATY_APPLICATION?: string;
  TRANSPORT_MODE?: string;
};

export type ServiceConnectionTarget = {
  endpoint?: string;
  binding?: ServiceBinding;
  bindingName?: string;
  scopes?: string[];
};

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
    caller: applicationFromEnv(env),
    transportMode: transportModeFromEnv(env),
    gatewayFetch: serviceBindingFetch(env.AUTH_GATEWAY, "AUTH_GATEWAY"),
    fetch: serviceBindingFetch(target.binding, target.bindingName),
  };
};
