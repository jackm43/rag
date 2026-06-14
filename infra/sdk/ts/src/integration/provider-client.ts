import type { Identity } from "../identity";
import { providerApiClient } from "../provider/api";
import type { PlatformClient } from "../client/fetch";

export type OAuthProviderClientConfig = {
  application: string;
  apiBaseUrl: string;
  gatewayUrl: string;
  gatewayFetch?: typeof fetch;
  fetch?: typeof fetch;
};

export const createOAuthProviderClient = (
  config: OAuthProviderClientConfig,
  identity: Identity,
): PlatformClient =>
  providerApiClient(
    {
      application: config.application,
      apiBaseUrl: config.apiBaseUrl,
      auth: {
        mode: "oauth",
        gatewayUrl: config.gatewayUrl,
        gatewayFetch: config.gatewayFetch,
      },
      fetch: config.fetch,
    },
    identity,
  );

export type ApiTokenProviderClientConfig = {
  application: string;
  apiBaseUrl: string;
  token: () => Promise<string | null>;
  tokenHeader?: string;
  bearer?: boolean;
  fetch?: typeof fetch;
};

export const createApiTokenProviderClient = (
  config: ApiTokenProviderClientConfig,
  identity: Identity,
): PlatformClient =>
  providerApiClient(
    {
      application: config.application,
      apiBaseUrl: config.apiBaseUrl,
      auth: {
        mode: "api_token",
        token: config.token,
        header: config.tokenHeader ?? "authorization",
        bearer: config.bearer,
      },
      fetch: config.fetch,
    },
    identity,
  );
