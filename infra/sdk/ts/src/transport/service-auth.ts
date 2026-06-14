import { jwtVerify } from "jose";

import type { ServiceCredential } from "../oauth2/credential";
import { remoteJwks } from "../oauth2/jwks";
import { stsJwksUrl } from "../oauth2/sts";
import { ttlCache } from "../client/cache";
import {
  CALLER_CLIENT_ID_HEADER,
  CALLER_SERVICE_HEADER,
  SERVICE_BINDING_TIMESTAMP_HEADER,
  SERVICE_BINDING_TOKEN_HEADER,
  SERVICE_BINDING_TOKEN_PATH,
  TARGET_SERVICE_HEADER,
  TRANSPORT_MODE_HEADER,
} from "./tokens";
import type { ServiceBindingVerifyRequest, ServiceBindingVerifyResponse } from "./types";

const MAX_BINDING_AGE_SECONDS = 300;

const bindingTokenCache = ttlCache<string>();

const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const bodyDigest = async (body: ArrayBuffer | null): Promise<string> => {
  if (!body || body.byteLength === 0) {
    return "";
  }
  return b64url(await crypto.subtle.digest("SHA-256", body));
};

export const fetchServiceBindingToken = async (
  credential: ServiceCredential,
  gatewayUrl: string,
  input: {
    caller: string;
    target: string;
    method: string;
    url: string;
    body?: ArrayBuffer | null;
  },
  gatewayFetch?: typeof fetch,
): Promise<{ token: string; timestamp: number; clientId: string }> => {
  const parsed = new URL(input.url, "https://transport.local");
  const path = `${parsed.pathname}${parsed.search}`;
  const digest = await bodyDigest(input.body ?? null);
  const cacheKey = `${credential.clientId}:${input.target}:${input.method.toUpperCase()}:${path}:${digest}`;
  const cached = bindingTokenCache.get(cacheKey);
  if (cached) {
    return { token: cached, timestamp: Math.floor(Date.now() / 1000), clientId: credential.clientId };
  }
  const issuer = gatewayUrl.replace(/\/$/, "");
  const auth = btoa(`${credential.clientId}:${credential.clientSecret}`);
  const response = await (gatewayFetch ?? fetch)(`${issuer}${SERVICE_BINDING_TOKEN_PATH}`, {
    method: "POST",
    headers: {
      authorization: `Basic ${auth}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      caller: input.caller,
      target: input.target,
      method: input.method.toUpperCase(),
      path,
      body_digest: digest,
    }),
  });
  if (!response.ok) {
    throw new Error(`service binding token refused (${response.status})`);
  }
  const body = (await response.json()) as { token?: string; expires_in?: number };
  if (!body.token) {
    throw new Error("service binding token missing from gateway response");
  }
  bindingTokenCache.set(cacheKey, body.token, body.expires_in ?? 60);
  return {
    token: body.token,
    timestamp: Math.floor(Date.now() / 1000),
    clientId: credential.clientId,
  };
};

export const createServiceBindingToken = fetchServiceBindingToken;

export const stampServiceBindingHeaders = (
  headers: Headers,
  binding: { token: string; timestamp: number; clientId: string; caller: string; target: string },
): void => {
  headers.set(TRANSPORT_MODE_HEADER, "service-auth");
  headers.set(CALLER_SERVICE_HEADER, binding.caller);
  headers.set(TARGET_SERVICE_HEADER, binding.target);
  headers.set(CALLER_CLIENT_ID_HEADER, binding.clientId);
  headers.set(SERVICE_BINDING_TOKEN_HEADER, binding.token);
  headers.set(SERVICE_BINDING_TIMESTAMP_HEADER, String(binding.timestamp));
};

export const verifyServiceBindingJwt = async (
  token: string,
  config: {
    issuer: string;
    audience: string;
    jwksUrl?: string;
    gatewayFetch?: typeof fetch;
  },
  request: { method: string; path: string; bodyDigest: string },
): Promise<ServiceBindingVerifyResponse | null> => {
  try {
    const { payload } = await jwtVerify(
      token,
      remoteJwks(config.jwksUrl ?? stsJwksUrl(config.issuer), config.gatewayFetch),
      {
        issuer: config.issuer.replace(/\/$/, ""),
        audience: config.audience,
      },
    );
    if (payload.kind !== "service-binding") {
      return null;
    }
    if (payload.bind_m !== request.method.toUpperCase()) {
      return null;
    }
    if (payload.bind_p !== request.path) {
      return null;
    }
    if ((payload.bind_d ?? "") !== request.bodyDigest) {
      return null;
    }
    const caller = typeof payload.caller === "string" ? payload.caller : undefined;
    if (!caller || typeof payload.sub !== "string") {
      return null;
    }
    return { valid: true, caller, target: config.audience };
  } catch {
    return null;
  }
};

export const verifyServiceBindingToken = verifyServiceBindingJwt;

export const readServiceBindingVerifyRequest = (
  headers: Headers,
  method: string,
  url: string,
  bodyDigestValue: string,
): ServiceBindingVerifyRequest | null => {
  if (headers.get(TRANSPORT_MODE_HEADER) !== "service-auth") {
    return null;
  }
  const caller = headers.get(CALLER_SERVICE_HEADER)?.trim() ?? "";
  const target = headers.get(TARGET_SERVICE_HEADER)?.trim() ?? "";
  const clientId = headers.get(CALLER_CLIENT_ID_HEADER)?.trim() ?? "";
  const token = headers.get(SERVICE_BINDING_TOKEN_HEADER)?.trim() ?? "";
  const timestamp = Number(headers.get(SERVICE_BINDING_TIMESTAMP_HEADER) ?? "");
  if (!caller || !target || !clientId || !token || !Number.isFinite(timestamp)) {
    return null;
  }
  const parsed = new URL(url);
  return {
    caller,
    target,
    clientId,
    token,
    timestamp,
    method: method.toUpperCase(),
    path: `${parsed.pathname}${parsed.search}`,
    bodyDigest: bodyDigestValue,
  };
};

export const bindingAgeValid = (timestamp: number): boolean =>
  Math.abs(Math.floor(Date.now() / 1000) - timestamp) <= MAX_BINDING_AGE_SECONDS;
