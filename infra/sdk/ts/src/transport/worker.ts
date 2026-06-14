import type { ServiceCredential } from "../oauth2/credential";
import { fetchServiceBindingToken, stampServiceBindingHeaders } from "./service-auth";
import type { TransportMode, WorkerTransportContext } from "./types";

export type ServiceBinding = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export const serviceBindingFetch = ((
  binding: ServiceBinding | undefined,
  bindingName?: string,
): typeof fetch | undefined => {
  if (!binding) {
    if (bindingName) {
      throw new Error(`service binding ${bindingName} is not configured`);
    }
    return undefined;
  }
  return (input, init) => binding.fetch(input, init);
}) as {
  (binding: ServiceBinding | undefined, bindingName: string): typeof fetch;
  (binding: ServiceBinding | undefined, bindingName?: string): typeof fetch | undefined;
};

export type WorkerTransportConfig = {
  mode: TransportMode;
  caller: string;
  target: string;
  credential: ServiceCredential;
  gatewayUrl?: string;
  gatewayFetch?: typeof fetch;
};

const readBody = async (request: Request): Promise<ArrayBuffer | null> => {
  if (request.method === "GET" || request.method === "HEAD") {
    return null;
  }
  return request.clone().arrayBuffer();
};

export const wrapWorkerBindingFetch = (
  bindingFetch: typeof fetch,
  config: WorkerTransportConfig,
): typeof fetch => {
  if (config.mode === "mtls") {
    return bindingFetch;
  }
  if (!config.gatewayUrl) {
    throw new Error(`worker transport ${config.caller}->${config.target} requires gatewayUrl`);
  }
  const gatewayUrl = config.gatewayUrl;
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = await readBody(request);
    const binding = await fetchServiceBindingToken(
      config.credential,
      gatewayUrl,
      {
        caller: config.caller,
        target: config.target,
        method: request.method,
        url: request.url,
        body,
      },
      config.gatewayFetch,
    );
    const headers = new Headers(request.headers);
    stampServiceBindingHeaders(headers, {
      ...binding,
      caller: config.caller,
      target: config.target,
    });
    return bindingFetch(
      new Request(request.url, {
        method: request.method,
        headers,
        body,
        redirect: request.redirect,
        signal: request.signal,
      }),
    );
  };
};

export const createWorkerTransportFetch = (
  bindingFetch: typeof fetch | undefined,
  context: WorkerTransportContext,
  options?: { requireBinding?: boolean },
): typeof fetch | undefined => {
  if (options?.requireBinding && !bindingFetch) {
    throw new Error(
      `worker transport ${context.caller}->${context.target} requires a service binding`,
    );
  }
  if (!bindingFetch || !context.caller || !context.target || !context.gatewayUrl) {
    return bindingFetch;
  }
  return wrapWorkerBindingFetch(bindingFetch, {
    mode: context.mode,
    caller: context.caller,
    target: context.target,
    credential: context.credential,
    gatewayUrl: context.gatewayUrl,
    gatewayFetch: context.gatewayFetch,
  });
};
