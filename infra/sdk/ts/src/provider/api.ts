import type { Identity } from "../identity";
import { errorMessage, logger } from "../logger";
import { traceHeaders } from "../otel";
import { ttlCache } from "../client/cache";
import { createClient, type PlatformClient } from "../client/fetch";
import { exchangeProviderAccessToken } from "./oauth";

// The provider API client is the standard outbound integration with an
// external provider API: every call requires the authenticated caller
// identity (handlers reach it only through protect), the provider credential
// is resolved and injected at this boundary, and every request is logged as a
// boundary crossing. Two credential modes cover the supported providers:
//
// - oauth: the caller's gateway token is exchanged (ExchangeProviderToken)
//   for a short-lived, user-delegated provider access token.
// - api_token: a static provider credential from a worker secret; the caller
//   identity still gates the call, but the provider sees the application.
export type ProviderApiAuth =
  | { mode: "oauth"; gatewayUrl: string; gatewayFetch?: typeof fetch }
  | { mode: "api_token"; token: string; header?: string };

export type ProviderApiConfig = {
  application: string;
  apiBaseUrl: string;
  auth: ProviderApiAuth;
  fetch?: typeof fetch;
};

export class ProviderApiAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderApiAuthError";
  }
}

const tokenCache = ttlCache<string>();

export const providerApiToken = async (
  config: ProviderApiConfig,
  identity: Identity,
): Promise<string> => {
  if (config.auth.mode === "api_token") {
    if (!config.auth.token) {
      throw new ProviderApiAuthError(
        `provider api ${config.application}: api token is not configured`,
      );
    }
    return config.auth.token;
  }
  if (!identity.subjectToken) {
    throw new ProviderApiAuthError(
      `provider api ${config.application}: caller identity cannot exchange (no subject token)`,
    );
  }
  const key = `${config.application}:${identity.subjectToken}`;
  const cached = tokenCache.get(key);
  if (cached) {
    return cached;
  }
  const minted = await exchangeProviderAccessToken(
    config.auth.gatewayUrl,
    config.application,
    `Bearer ${identity.subjectToken}`,
    config.auth.gatewayFetch,
  );
  tokenCache.set(key, minted.accessToken, minted.expiresIn);
  return minted.accessToken;
};

export const providerApiClient = (
  config: ProviderApiConfig,
  identity: Identity,
): PlatformClient => {
  const header =
    config.auth.mode === "api_token" ? (config.auth.header ?? "authorization") : "authorization";
  const platform = createClient({
    endpoint: config.apiBaseUrl,
    fetch: config.fetch,
    decorate: async (headers) => {
      const token = await providerApiToken(config, identity);
      headers.set(header, header === "authorization" ? `Bearer ${token}` : token);
      for (const [key, value] of Object.entries(traceHeaders())) {
        headers.set(key, value);
      }
    },
  });
  const actor = identity.email ?? identity.subject;
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const start = Date.now();
    try {
      const response = await platform.fetch(input, init);
      logger.info("provider_api_client", {
        application: config.application,
        path: input,
        actor,
        status: response.status,
        duration_ms: Date.now() - start,
      });
      return response;
    } catch (error) {
      logger.warn("provider_api_client_failed", {
        application: config.application,
        path: input,
        actor,
        duration_ms: Date.now() - start,
        error: errorMessage(error),
      });
      throw error;
    }
  };
  return { fetch, call: platform.call };
};
