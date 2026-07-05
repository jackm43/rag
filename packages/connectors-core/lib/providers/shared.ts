import type { BoundaryFetch } from "@rag/outbound/boundary-client";
import type { Env } from "../../contracts";
import { resolveSecretRef, type SecretRef } from "@rag/secrets";
import { ConnectorError } from "../types";

// Provider-support helpers shared across the provider files. Credential
// resolution goes through the secrets-provider module; the HTTP helpers below
// wrap the OAuth token-endpoint calls every OAuth-shaped provider makes.

// Resolve a connector's secret reference through the secrets-provider module,
// failing closed (500) when it cannot be resolved — a connector whose secret is
// missing or unreachable can never produce a credential, so a use could never
// succeed. This is the SECRET-RESOLUTION GATE: null from any backend denies the
// connector op rather than surfacing a half-resolved credential.
export const resolveSecret = async (env: Env, ref: SecretRef): Promise<string> => {
  const value = await resolveSecretRef(env, ref);
  if (!value) {
    throw new ConnectorError(500, `secret_unresolved:${ref.provider}`);
  }
  return value;
};

// POST an application/x-www-form-urlencoded body through the connector's boundary
// client and parse a JSON response, failing closed (502) on any non-2xx or
// unparseable body. Used by the OAuth token endpoints.
export const postForm = async (
  fetch: BoundaryFetch,
  url: string,
  form: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...headers },
    body: new URLSearchParams(form).toString(),
  });
  if (!response.ok) {
    throw new ConnectorError(502, `token_endpoint_status:${response.status}`);
  }
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    throw new ConnectorError(502, "token_endpoint_body");
  }
};

// HTTP Basic credentials for confidential-client token requests.
export const basicAuth = (id: string, secret: string): string =>
  `Basic ${btoa(`${id}:${secret}`)}`;

// Coerce a provider `expires_in` (seconds-from-now) into an absolute epoch second.
export const expiresAtFrom = (expiresIn: unknown, nowMs: number): number | undefined =>
  typeof expiresIn === "number" && Number.isFinite(expiresIn)
    ? Math.floor(nowMs / 1000) + expiresIn
    : undefined;
