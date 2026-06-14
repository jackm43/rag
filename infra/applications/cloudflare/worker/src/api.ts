import { createOAuthProviderClient, serviceBindingFetch, type Identity, type PlatformClient } from "@platy/sdk";

import { failedPrecondition } from "./errors";
import type { Env } from "./types";

export const API_BASE_URL = "https://api.cloudflare.com/client/v4";

type ApiEnvelope<T> = {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: T;
  result_info?: {
    count?: number;
    cursor?: string;
    per_page?: number;
  };
};

export const cloudflareApiClient = (env: Env, identity: Identity): PlatformClient =>
  createOAuthProviderClient(
    {
      application: "cloudflare",
      apiBaseUrl: API_BASE_URL,
      gatewayUrl: env.AUTH_GATEWAY_URL,
      gatewayFetch: serviceBindingFetch(env.AUTH_GATEWAY, "AUTH_GATEWAY"),
    },
    identity,
  );

export const apiRequest = async <T>(
  client: PlatformClient,
  path: string,
  init?: RequestInit,
): Promise<{ result: T; resultInfo?: ApiEnvelope<T>["result_info"] }> => {
  const response = await client.fetch(path, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !body.success) {
    const detail = (body.errors ?? []).map((error) => `${error.code} ${error.message}`).join("; ");
    failedPrecondition(`cloudflare api error (${response.status}): ${detail || "unknown"}`);
  }
  if (body.result === undefined) {
    return { result: {} as T, resultInfo: body.result_info };
  }
  return { result: body.result, resultInfo: body.result_info };
};

export const appendQuery = (path: string, params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") {
      continue;
    }
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
};
