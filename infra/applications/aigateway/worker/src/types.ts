export interface Env {
  // Auth gateway issuer base URL (STS token verification).
  AUTH_GATEWAY_URL: string;
  // Service binding to the auth-gateway worker, used to fetch JWKS without a
  // public round trip (optional; falls back to fetching the public JWKS URL).
  AUTH_GATEWAY?: Fetcher;
  // Cloudflare account that owns the AI Gateway.
  CF_ACCOUNT_ID: string;
  // AI Gateway id (e.g. "platy").
  AIG_GATEWAY_ID: string;
  // Default provider-qualified model when a request omits one.
  AIG_DEFAULT_MODEL: string;
  // Comma-separated origins allowed to call the service from a browser.
  AIG_ALLOWED_ORIGINS?: string;
  // Authorization token for the authenticated AI Gateway. Injected as
  // `cf-aig-authorization: Bearer <token>` on every outbound call. Delivered as
  // a worker secret from a vault reference; never hardcoded.
  CF_AIG_TOKEN: string;
  // Service credential pushed by `platy deploy`; used for the session-chain
  // (backend-for-frontend) exchange so browsers only carry session tokens.
  SERVICE_CLIENT_ID?: string;
  SERVICE_CLIENT_SECRET?: string;
  // Ragbot connector: service binding plus base URL (same-account
  // worker-to-worker fetches require the binding; the URL names the host).
  RAGBOT?: Fetcher;
  RAGBOT_ENDPOINT?: string;
  // OTEL: service name override and optional OTLP/HTTP export target.
  OTEL_SERVICE_NAME?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
}
