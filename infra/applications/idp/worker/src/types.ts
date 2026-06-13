import type { WorkerSecret } from "@platy/sdk";

export interface Env {
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_OIDC_CLIENT_ID: string;
  GATEWAY_ISSUER: string;
  ALLOWED_EMAILS: string;
  ALLOWED_GUILD_IDS?: string;
  DISCORD_APPLICATION_ID?: WorkerSecret;
  DISCORD_CLIENT_SECRET?: WorkerSecret;
  GATEWAY_ALLOWED_ORIGINS?: string;
  PROVIDER_OAUTH_CLIENTS?: WorkerSecret;
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

export const isInternalEmail = (env: Env, email: string | null): boolean =>
  email !== null && allowedEmails(env).includes(email.toLowerCase());
