import {
  createPlatformCatalogClient,
  type PlatformCatalogClientOptions,
  type PlatformCatalogClients,
  type PlatformCatalogMethod,
  type PlatformCatalogServiceClient,
  type PlatformCatalogStreamMethod,
  type PlatformCatalogTransport,
  type PlatformCatalogUnaryMethod,
} from "./platform-catalog-client";

export type PlatformWebTransport = {
  request(application: string, path: string, init?: RequestInit): Promise<Response>;
};

export type PlatformWebClientOptions = PlatformCatalogClientOptions;

export type PlatformWebUnaryMethod = PlatformCatalogUnaryMethod;
export type PlatformWebStreamMethod = PlatformCatalogStreamMethod;
export type PlatformWebMethod = PlatformCatalogMethod;
export type PlatformWebServiceClient = PlatformCatalogServiceClient;
export type PlatformWebClients = PlatformCatalogClients;

export const createPlatformWebClient = (
  application: string,
  transport: PlatformWebTransport,
  options: PlatformWebClientOptions = {},
): PlatformWebClients =>
  createPlatformCatalogClient(application, {
    fetch: (path, init) => transport.request(application, path, init),
  }, options);

export type { PlatformCatalogTransport };
