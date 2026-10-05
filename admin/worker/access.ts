// Cloudflare Access sits in front of the admin hostname; the Worker checks its JWT as well.
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AdminEnv } from "./index.ts";

let keys: ReturnType<typeof createRemoteJWKSet> | undefined;

/**
 * The signed-in user's email, or null when the request did not come through the Access app.
 * `vite dev` on localhost has no Access in front of it; production builds drop that branch.
 */
export async function accessUser(request: Request, env: AdminEnv): Promise<string | null> {
  if (import.meta.env.DEV && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname)) return "local dev";
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || !env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) return null;
  keys ??= createRemoteJWKSet(new URL("/cdn-cgi/access/certs", env.ACCESS_TEAM_DOMAIN));
  try {
    const { payload } = await jwtVerify(token, keys, { issuer: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD });
    // People carry an email; Access service tokens carry their common name instead.
    return String(payload.email || payload.common_name || "") || null;
  } catch {
    return null;
  }
}
