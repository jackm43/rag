import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { ensureHome, tokenPath } from "./config";

// Cloudflare Access token acquisition, delegated to the standard `cloudflared`
// tool. The dev-proxy sits behind a Cloudflare Access application; `cloudflared
// access login` runs the browser SSO flow and `cloudflared access token`
// prints the short-lived application JWT. ragctl caches that token locally (0600)
// and hands it to the typed client as the `Cf-Access-Jwt-Assertion` header —
// exactly the header the worker's cf-access guard verifies.
//
// ragctl never mints or verifies the Access token itself; it only caches what
// cloudflared returns and decodes the (already-signed) claims for display.

const decoder = new TextDecoder();

const bytesFromB64url = (value: string): Uint8Array => {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

export type AccessClaims = {
  sub?: string;
  email?: string;
  iss?: string;
  aud?: unknown;
  exp?: number;
  iat?: number;
  [key: string]: unknown;
};

// Decode a JWT's claims WITHOUT verifying the signature. Safe here: the token
// came straight from cloudflared and is re-verified by the worker; we only read
// it to show the operator who they are and when the token expires.
export const decodeClaims = (token: string): AccessClaims => {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("cached Access token is not a JWT");
  }
  return JSON.parse(decoder.decode(bytesFromB64url(parts[1]))) as AccessClaims;
};

export type CachedToken = {
  token: string;
  appUrl: string;
  fetchedAt: string;
  // Unix seconds, mirrored from the token's exp claim for a cheap staleness check.
  exp: number | null;
};

const CLOUDFLARED_MISSING = [
  "cloudflared not found on PATH.",
  "Install it (macOS: `brew install cloudflared`) or see",
  "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
].join(" ");

const cloudflaredInstalled = (): boolean => {
  const probe = spawnSync("cloudflared", ["--version"], { encoding: "utf8" });
  return probe.error === undefined && probe.status === 0;
};

export const requireCloudflared = (): void => {
  if (!cloudflaredInstalled()) {
    throw new Error(CLOUDFLARED_MISSING);
  }
};

const cacheToken = (token: string, appUrl: string): CachedToken => {
  const claims = decodeClaims(token);
  const cached: CachedToken = {
    token,
    appUrl,
    fetchedAt: new Date().toISOString(),
    exp: typeof claims.exp === "number" ? claims.exp : null,
  };
  ensureHome();
  writeFileSync(tokenPath(), `${JSON.stringify(cached, null, 2)}\n`, { mode: 0o600 });
  return cached;
};

// Fetch the current Access token for the app (assumes an existing login session)
// and cache it.
export const fetchToken = (accessUrl: string): CachedToken => {
  requireCloudflared();
  const result = spawnSync("cloudflared", ["access", "token", `-app=${accessUrl}`], { encoding: "utf8" });
  const token = result.stdout?.trim();
  if (result.status !== 0 || !token) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`cloudflared could not return a token${detail ? `: ${detail}` : ""}`);
  }
  return cacheToken(token, accessUrl);
};

// Run the interactive browser SSO login, then fetch + cache the token.
export const login = (accessUrl: string): CachedToken => {
  requireCloudflared();
  const result = spawnSync("cloudflared", ["access", "login", accessUrl], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error("cloudflared access login failed");
  }
  return fetchToken(accessUrl);
};

export const readCachedToken = (): CachedToken | null => {
  const path = tokenPath();
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, "utf8")) as CachedToken;
};

export const tokenIsExpired = (cached: CachedToken, now = Math.floor(Date.now() / 1000)): boolean =>
  cached.exp !== null && now >= cached.exp;
