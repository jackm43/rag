import { guardDenial, type InboundGuard } from "./guard";
import { timingSafeEqual } from "./timing-safe-equal";
import type { AuthEnv } from "./env";

// OAuth2 client-credentials verification for machine clients. A client presents
// HTTP Basic credentials (Authorization: Basic base64(clientId:clientSecret));
// the pair is checked, constant-time, against the OAUTH2_CLIENTS registry (a
// JSON map of clientId -> secret). This is the minimal resource-server side of
// the client-credentials grant; a fuller build (JWT access tokens, an
// introspection endpoint, scopes) slots in behind the same guard shape.

const encoder = new TextEncoder();

export type OAuth2ClientPrincipal = {
  principal: "oauth2-client";
  clientId: string;
};

const clientRegistry = (raw: string | undefined): Record<string, string> => {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [id, secret] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof secret === "string") out[id] = secret;
      }
      return out;
    }
  } catch {
    // fall through to empty registry (deny all)
  }
  return {};
};

const decodeBasic = (authorization: string): { clientId: string; clientSecret: string } | null => {
  const separator = authorization.indexOf(" ");
  if (separator === -1 || authorization.slice(0, separator).toLowerCase() !== "basic") {
    return null;
  }
  let decoded: string;
  try {
    decoded = atob(authorization.slice(separator + 1));
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon === -1) return null;
  return { clientId: decoded.slice(0, colon), clientSecret: decoded.slice(colon + 1) };
};

const secretsMatch = (actual: string, expected: string) =>
  timingSafeEqual(encoder.encode(actual), encoder.encode(expected));

// Verifies an OAuth2 client-credentials request. Fails closed when the registry
// is unconfigured/empty or the credentials do not match a registered client.
export const oauth2ClientGuard: InboundGuard<OAuth2ClientPrincipal> = {
  identity: "oauth2-client",
  verify: async (request, env: AuthEnv) => {
    const unauthorized = () => new Response("Unauthorized", { status: 401 });
    const authorization = request.headers.get("authorization");
    const basic = authorization ? decodeBasic(authorization) : null;
    if (!basic) {
      return guardDenial(oauth2ClientGuard, "missing_client_credentials", unauthorized());
    }
    const expected = clientRegistry(env.OAUTH2_CLIENTS)[basic.clientId];
    if (typeof expected !== "string" || expected.length === 0 || !secretsMatch(basic.clientSecret, expected)) {
      return guardDenial(oauth2ClientGuard, "invalid_client_credentials", unauthorized());
    }
    return { ok: true, grant: { principal: "oauth2-client", clientId: basic.clientId } };
  },
};
