import { ConnectorError, type ConnectorProvider, type ConnectorStrategy } from "../types";
import { resolveSecret } from "./shared";

// api-key provider (api_key kind): the broker holds a static API key and injects
// it into a configured header. It is still "3-legged" — a caller grants (proving
// its identity) to get a handle, then uses the handle; the key itself never
// leaves the broker.
//
// There is no mintable short-lived token, so connector.token fails closed for
// this kind: the only way to use an api_key connector is authorizedFetch, which
// keeps the key broker-side.
const DEFAULT_GRANT_TTL_SECONDS = 300;

const apiKeyStrategy: ConnectorStrategy = {
  kind: "api_key",
  prepare: async (ctx) => {
    // Validate the secret resolves so a grant is only issued when a use could
    // actually succeed (fail closed at grant time, not surprisingly on use).
    await resolveSecret(ctx.env, ctx.connector.secret);
    const ttl = ctx.connector.grantTtlSeconds ?? DEFAULT_GRANT_TTL_SECONDS;
    return { expiresAt: Math.floor(ctx.now() / 1000) + ttl };
  },
  inject: async (ctx) => {
    const key = await resolveSecret(ctx.env, ctx.connector.secret);
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

export const apiKeyProvider: ConnectorProvider = {
  name: "api-key",
  kinds: ["api_key"],
  strategies: [apiKeyStrategy],
};
