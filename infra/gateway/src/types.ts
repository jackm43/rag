export interface Env {
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_OIDC_CLIENT_ID: string;
  GATEWAY_ISSUER: string;
  ALLOWED_EMAILS: string;
  // Comma-separated browser origins allowed to call session and token-exchange
  // endpoints with CORS (Module 3 web clients).
  GATEWAY_ALLOWED_ORIGINS?: string;
  // OTEL: service name override and optional OTLP/HTTP export target.
  OTEL_SERVICE_NAME?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
  SIGNING_KEYS: DurableObjectNamespace;
  DB: D1Database;
}

export const allowedEmails = (env: Env): string[] =>
  env.ALLOWED_EMAILS.split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
