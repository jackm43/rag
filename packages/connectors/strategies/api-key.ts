import { ConnectorError, type ConnectorStrategy } from "../types";
import { requireSecret } from "./shared";

// api_key: the broker holds a static API key and injects it into a configured
// header. It is still "3-legged" — a caller grants (proving its identity) to get
// a handle, then uses the handle; the key itself never leaves the broker.
//
// There is no mintable short-lived token, so connector.token fails closed for
// this kind: the only way to use an api_key connector is authorizedFetch, which
// keeps the key broker-side.
const DEFAULT_GRANT_TTL_SECONDS = 300;

export const apiKeyStrategy: ConnectorStrategy = {
  kind: "api_key",
  prepare: async (ctx) => {
    // Validate the secret is present so a grant is only issued when a use could
    // actually succeed (fail closed at grant time, not surprisingly on use).
    requireSecret(ctx.env, ctx.connector.secretBinding);
    const ttl = ctx.connector.grantTtlSeconds ?? DEFAULT_GRANT_TTL_SECONDS;
    return { expiresAt: Math.floor(ctx.now() / 1000) + ttl };
  },
  inject: async (ctx) => {
    const key = requireSecret(ctx.env, ctx.connector.secretBinding);
    const template = ctx.connector.headerTemplate ?? { header: "authorization", scheme: "Bearer" };
    const value = template.scheme ? `${template.scheme} ${key}` : key;
    return { [template.header]: value, ...(ctx.connector.staticHeaders ?? {}) };
  },
  token: async () => {
    // An API key is not a short-lived bearer token; there is nothing safe to hand
    // back. Callers must use authorizedFetch.
    throw new ConnectorError(400, "token_unsupported_for_api_key");
  },
};
