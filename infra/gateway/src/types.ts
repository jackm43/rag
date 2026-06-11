export interface Env {
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_OIDC_CLIENT_ID: string;
  GATEWAY_ISSUER: string;
  ALLOWED_EMAILS: string;
  SIGNING_KEYS: DurableObjectNamespace;
  DB: D1Database;
}

export const allowedEmails = (env: Env): string[] =>
  env.ALLOWED_EMAILS.split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
