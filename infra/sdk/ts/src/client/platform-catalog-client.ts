import { registeredCatalogApplication } from "../catalog/register";
import { readNdjsonStream } from "../http/ndjson";
import { methodClientKey, serviceClientKey } from "../integration/naming";

export type PlatformCatalogTransport = {
  fetch(path: string, init?: RequestInit): Promise<Response>;
};

export type PlatformCatalogClientOptions = {
  headers?: HeadersInit;
  signal?: AbortSignal;
};

const mergeHeaders = (left?: HeadersInit, right?: HeadersInit): Headers => {
  const headers = new Headers(left);
  if (right) {
    new Headers(right).forEach((value, key) => {
      headers.set(key, value);
    });
  }
  return headers;
};

const unwrap = async <T>(response: Response): Promise<T> => {
  const body = await response.json() as { data?: T; errors?: Array<{ detail?: string; title?: string }> };
  if (!response.ok) {
    throw new Error(body.errors?.[0]?.detail ?? body.errors?.[0]?.title ?? `request failed (${response.status})`);
  }
  return body.data as T;
};

const fillPath = (template: string, params: Record<string, unknown>): string =>
  template.replace(/\{([^}]+)\}/g, (_, key: string) => encodeURIComponent(String(params[key] ?? "")));

const appendQuery = (path: string, params: Record<string, unknown>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        search.append(key, String(item));
      }
      continue;
    }
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}${path.includes("?") ? "&" : "?"}${query}` : path;
};

const requestBodyKeys = (request: Record<string, unknown>, pathParams: string[] = []): Record<string, unknown> => {
  const omitted = new Set([...pathParams, "signal"]);
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request)) {
    if (!omitted.has(key)) {
      body[key] = value;
    }
  }
  return body;
};

export type PlatformCatalogUnaryMethod = (request?: Record<string, unknown>) => Promise<unknown>;

export type PlatformCatalogStreamMethod = (
  request?: Record<string, unknown>,
  options?: { signal?: AbortSignal },
) => AsyncGenerator<unknown, void, unknown>;

export type PlatformCatalogMethod = PlatformCatalogUnaryMethod | PlatformCatalogStreamMethod;

export type PlatformCatalogServiceClient = Record<string, PlatformCatalogMethod>;

export type PlatformCatalogClients = Record<string, () => PlatformCatalogServiceClient>;

export const createPlatformCatalogClient = (
  application: string,
  transport: PlatformCatalogTransport,
  options: PlatformCatalogClientOptions = {},
): PlatformCatalogClients => {
  const app = registeredCatalogApplication(application);
  const request = async <T>(path: string, init: RequestInit = {}): Promise<T> =>
    unwrap<T>(await transport.fetch(path, {
      ...init,
      headers: mergeHeaders(options.headers, init.headers),
      signal: init.signal ?? options.signal,
    }));

  const clients: PlatformCatalogClients = {};
  for (const resource of app.resources) {
    clients[serviceClientKey(resource.name)] = () => {
      const methods: PlatformCatalogServiceClient = {};
      for (const method of resource.methods) {
        const clientMethod = methodClientKey(method.name);
        if (method.http.stream === "ndjson") {
          methods[clientMethod] = (async function* (
            requestBody: Record<string, unknown> = {},
            streamOptions?: { signal?: AbortSignal },
          ) {
            const pathParams = method.http.pathParams ?? [];
            const path = fillPath(method.http.path, requestBody);
            const response = await transport.fetch(path, {
              method: method.http.method,
              headers: mergeHeaders({ "content-type": "application/json" }, options.headers),
              body: JSON.stringify({ data: requestBodyKeys(requestBody, pathParams) }),
              signal: streamOptions?.signal ?? options.signal,
            });
            yield* readNdjsonStream<unknown>(response);
          }) as PlatformCatalogStreamMethod;
          continue;
        }
        methods[clientMethod] = (async (requestBody: Record<string, unknown> = {}) => {
          const pathParams = method.http.pathParams ?? [];
          const path = appendQuery(fillPath(method.http.path, requestBody), requestBody);
          if (method.http.method === "GET" || method.http.method === "DELETE") {
            return request(path, { method: method.http.method });
          }
          return request(path, {
            method: method.http.method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ data: requestBodyKeys(requestBody, pathParams) }),
          });
        }) as PlatformCatalogUnaryMethod;
      }
      return methods;
    };
  }
  return clients;
};
