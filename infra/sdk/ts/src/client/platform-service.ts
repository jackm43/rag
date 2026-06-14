import type { Identity } from "../identity";
import {
  createPlatformCatalogClient,
  type PlatformCatalogTransport,
} from "./platform-catalog-client";
import {
  connectorToken,
  type ConnectorConfig,
} from "./connector";
import { createClient, type PlatformClient } from "./fetch";
import { generateDpopKey, type DpopKey } from "../oauth2/dpop";
import { traceHeaders } from "../otel/context";

export type PlatformServiceConnection = Omit<ConnectorConfig, "application">;

const dpopKeys = new Map<string, Promise<DpopKey>>();

const dpopKey = (application: string): Promise<DpopKey> => {
  let promise = dpopKeys.get(application);
  if (!promise) {
    promise = generateDpopKey();
    dpopKeys.set(application, promise);
  }
  return promise;
};

export const createPlatformServiceClient = (
  application: string,
  connection: PlatformServiceConnection,
  identity: Identity,
) => {
  const clientPromise = (async (): Promise<PlatformClient> =>
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
  const transport: PlatformCatalogTransport = {
    fetch: async (path, init) => (await clientPromise).fetch(path, init),
  };
  return createPlatformCatalogClient(application, transport);
};
