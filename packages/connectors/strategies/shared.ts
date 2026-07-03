import type { Env } from "../../contracts/types";
import type { BoundaryFetch } from "../../boundaries/outbound/boundary-client";
import { ConnectorError } from "../types";

// Read a required secret from env by binding name, failing closed (500) when the
// operator has not provisioned it — a connector with no secret can never resolve
// a credential, so this is an internal misconfiguration, not a caller error.
export const requireSecret = (env: Env, binding: string): string => {
  const value = (env as unknown as Record<string, string | undefined>)[binding];
  if (!value) {
    throw new ConnectorError(500, `secret_missing:${binding}`);
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
