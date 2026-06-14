import type { Identity } from "../identity";
import { proxyTargetFor, sessionProxy, type ProxyTarget } from "../auth/proxy";
import {
  connectorToken,
  type ConnectorConfig,
} from "./connector";
import { createClient } from "./fetch";
import { generateDpopKey, type DpopKey } from "../oauth2/dpop";
import type { ServiceCredential } from "../oauth2/exchange";
import { traceHeaders } from "../otel/context";
import type { StsVerifierConfig } from "../oauth2/sts";
import { transportModeFromEnv, type TransportEnv, type TransportMode } from "../transport";
import {
  createPlatformCatalogClient,
  type PlatformCatalogClientOptions,
  type PlatformCatalogClients,
  type PlatformCatalogTransport,
} from "./platform-catalog-client";

export type PlatformAuthTarget = {
  audience: string;
  endpoint: string;
  scopes?: string[];
  prefixes?: string[];
  fetch?: typeof fetch;
};

export type PlatformAuthConfig = {
  application: string;
  gatewayUrl?: string;
  credential?: ServiceCredential;
  identity?: Identity;
  targets?: PlatformAuthTarget[];
  gatewayFetch?: typeof fetch;
  verify?: Partial<StsVerifierConfig>;
  transportMode?: TransportMode;
  request?: (application: string, path: string, init?: RequestInit) => Promise<Response>;
} & TransportEnv;

export type PlatformAuthTargetClient = {
  audience: string;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  catalog(options?: PlatformCatalogClientOptions): PlatformCatalogClients;
};

export type PlatformAuthClient = {
  application: string;
  targets(): string[];
  target(audience: string): PlatformAuthTargetClient;
  catalog(application: string, options?: PlatformCatalogClientOptions): PlatformCatalogClients;
  proxy?(request: Request): Promise<Response | null>;
};

const dpopKeys = new Map<string, Promise<DpopKey>>();

const dpopKey = (application: string): Promise<DpopKey> => {
  let promise = dpopKeys.get(application);
  if (!promise) {
    promise = generateDpopKey();
    dpopKeys.set(application, promise);
  }
  return promise;
};

const connectorTransport = (
  application: string,
  connection: Omit<ConnectorConfig, "application">,
  identity: Identity,
): PlatformCatalogTransport => {
  const clientPromise = (async () =>
    createClient({
      endpoint: connection.endpoint,
      fetch: connection.fetch,
      token: () => connectorToken({ ...connection, application }, identity),
      dpop: await dpopKey(application),
      decorate: (headers: Headers) => {
        for (const [key, value] of Object.entries(traceHeaders())) {
          headers.set(key, value);
        }
      },
    }))();
  return {
    fetch: async (path, init) => (await clientPromise).fetch(path, init),
  };
};

const browserTransport = (
  application: string,
  request: NonNullable<PlatformAuthConfig["request"]>,
): PlatformCatalogTransport => ({
  fetch: (path, init) => request(application, path, init),
});

const resolveTarget = (config: PlatformAuthConfig, audience: string): PlatformAuthTarget => {
  const target = config.targets?.find((entry) => entry.audience === audience);
  if (!target) {
    throw new Error(`application ${config.application} has no auth target for ${audience}`);
  }
  return target;
};

const chainedTargetTransport = (
  config: PlatformAuthConfig,
  target: PlatformAuthTarget,
  identity: Identity,
): PlatformCatalogTransport => {
  if (!config.gatewayUrl || !config.credential) {
    throw new Error(`chained auth requires gatewayUrl and credential for ${target.audience}`);
  }
  return connectorTransport(target.audience, {
    endpoint: target.endpoint,
    gatewayUrl: config.gatewayUrl,
    credential: config.credential,
    scopes: target.scopes,
    caller: config.application,
    transportMode: config.transportMode ?? transportModeFromEnv(config),
    gatewayFetch: config.gatewayFetch,
    fetch: target.fetch,
  }, identity);
};

const targetClient = (
  config: PlatformAuthConfig,
  audience: string,
  transport: PlatformCatalogTransport,
): PlatformAuthTargetClient => ({
  audience,
  fetch: (path, init) => transport.fetch(path, init),
  catalog: (options) => createPlatformCatalogClient(audience, transport, options),
});

export const createPlatformAuthClient = (config: PlatformAuthConfig): PlatformAuthClient => {
  if (config.request) {
    return {
      application: config.application,
      targets: () => config.targets?.map((target) => target.audience) ?? [config.application],
      target: (audience) =>
        targetClient(config, audience, browserTransport(audience, config.request!)),
      catalog: (application, options) =>
        createPlatformCatalogClient(application, browserTransport(application, config.request!), options),
    };
  }

  if (!config.gatewayUrl || !config.credential) {
    throw new Error(`auth client ${config.application} requires gatewayUrl and credential`);
  }

  const proxyTargets: ProxyTarget[] = (config.targets ?? []).map((target) =>
    proxyTargetFor(target.audience, target),
  );
  const proxy = config.targets?.length
    ? sessionProxy({
      application: config.application,
      gatewayUrl: config.gatewayUrl,
      credential: config.credential,
      verify: config.verify,
      transportMode: config.transportMode ?? transportModeFromEnv(config),
      gatewayFetch: config.gatewayFetch,
      targets: proxyTargets,
    })
    : undefined;

  const requireIdentity = (): Identity => {
    if (!config.identity) {
      throw new Error(`auth client ${config.application} requires identity for outbound calls`);
    }
    return config.identity;
  };

  return {
    application: config.application,
    targets: () => (config.targets ?? []).map((target) => target.audience),
    target: (audience) =>
      targetClient(
        config,
        audience,
        chainedTargetTransport(config, resolveTarget(config, audience), requireIdentity()),
      ),
    catalog: (application, options) =>
      createPlatformCatalogClient(
        application,
        chainedTargetTransport(config, resolveTarget(config, application), requireIdentity()),
        options,
      ),
    ...(proxy ? { proxy } : {}),
  };
};

export const platformAuthClientFromIdentity = (
  config: PlatformAuthConfig & { identity: Identity },
): PlatformAuthClient => createPlatformAuthClient(config);
