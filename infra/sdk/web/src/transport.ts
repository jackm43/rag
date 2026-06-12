import { createClient, type Client, type Interceptor, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import type { DescService } from "@bufbuild/protobuf";

import type { TrustZoneWebAuth } from "./trustzone";

export type WebClientOptions = {
  // Extra headers stamped on every request — e.g. a client-instance id
  // (`x-client-instance`) so the proxy partitions tokens per chat and spans
  // carry the instance along the request path.
  headers?: Record<string, string>;
};

// webTransport is the factory every page-level client goes through: it
// resolves a registered application's endpoint from discovery and attaches
// the DPoP-bound *session* token plus a fresh proof for each request. The
// browser stays a dumb public client — the application validates the sender
// constraint and mints its own audience token server-side (client-credentials
// chaining), so no audience logic, scope handling, or secret is ever needed
// here. The Connect protocol gives server-streaming for free.
// The transport owns the cross-cutting concerns for every generated browser
// client: session auth + proof, per-instance headers, trace rooting (via
// authHeaders), and boundary logging — generated clients and pages never
// re-implement any of it.
const authInterceptor = (auth: TrustZoneWebAuth, options: WebClientOptions): Interceptor =>
  (next) => async (req) => {
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      req.header.set(key, value);
    }
    const headers = await auth.authHeaders("POST", req.url);
    for (const [key, value] of Object.entries(headers)) {
      req.header.set(key, value);
    }
    const method = `${req.service.typeName}/${req.method.name}`;
    const start = Date.now();
    try {
      const response = await next(req);
      console.debug(
        JSON.stringify({
          message: "rpc_client",
          method,
          trace: headers.traceparent,
          duration_ms: Date.now() - start,
        }),
      );
      return response;
    } catch (error) {
      console.warn(
        JSON.stringify({
          message: "rpc_client_failed",
          method,
          trace: headers.traceparent,
          duration_ms: Date.now() - start,
          error: (error as Error).message,
        }),
      );
      throw error;
    }
  };

export const webTransport = (
  auth: TrustZoneWebAuth,
  application: string,
  options: WebClientOptions = {},
): Transport => {
  const endpoint = auth.applicationEndpoint(application);
  if (!endpoint) {
    throw new Error(`application ${application} is not available`);
  }
  return createConnectTransport({
    baseUrl: endpoint.replace(/\/$/, ""),
    interceptors: [authInterceptor(auth, options)],
  });
};

// gatewayTransport targets the auth gateway itself (TraceService,
// ClientIdentityService, …) — same session auth, gateway origin from
// discovery (same-origin when "gateway" is in sameOrigin).
export const gatewayTransport = (
  auth: TrustZoneWebAuth,
  options: WebClientOptions = {},
): Transport =>
  createConnectTransport({
    baseUrl: auth.gatewayOrigin(),
    interceptors: [authInterceptor(auth, options)],
  });

export const gatewayClient = <S extends DescService>(
  auth: TrustZoneWebAuth,
  service: S,
  options: WebClientOptions = {},
): Client<S> => createClient(service, gatewayTransport(auth, options));

// webClient binds a generated Connect service to an application's transport.
// Generated per-application clients (infra/applications/<app>/web) wrap this
// so a page constructs a typed client in one line.
export const webClient = <S extends DescService>(
  auth: TrustZoneWebAuth,
  application: string,
  service: S,
  options: WebClientOptions = {},
): Client<S> => createClient(service, webTransport(auth, application, options));
