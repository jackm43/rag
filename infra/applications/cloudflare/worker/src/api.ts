import { Code, ConnectError } from "@connectrpc/connect";

import { providerApiClient, type Identity, type PlatformClient } from "../../../../sdk/ts/src";
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
  providerApiClient(
    {
      application: "cloudflare",
      apiBaseUrl: API_BASE_URL,
      auth: {
        mode: "oauth",
        gatewayUrl: env.AUTH_GATEWAY_URL,
        gatewayFetch: env.AUTH_GATEWAY
          ? (input: RequestInfo | URL, init?: RequestInit) => env.AUTH_GATEWAY!.fetch(input, init)
          : undefined,
      },
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
    throw new ConnectError(
      `cloudflare api error (${response.status}): ${detail || "unknown"}`,
      Code.FailedPrecondition,
    );
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
