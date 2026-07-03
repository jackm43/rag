import type { BoundaryFetch } from "../../boundaries/outbound/boundary-client";
import type { Env } from "../../contracts/types";
import {
  ConnectorError,
  type ConnectorConfig,
  type ConnectorProvider,
  type ConnectorStrategy,
  type ResolvedToken,
  type StrategyContext,
} from "../types";
import { resolveSecret } from "./shared";

// github provider (github_app kind): the reference connector, and the single
// home for all GitHub App code — the JWT crypto, the installation-token
// exchange, and the header injection. A GitHub App authenticates in two steps:
// it signs a short-lived App JWT (RS256) with its private key, then exchanges
// that JWT for an installation access token scoped to one installation, cached
// until shortly before expiry. Neither the private key nor the installation
// token leaves the broker on the fetch path; connector.token can hand back the
// installation token for the rare direct-call case.
//
// The installation is named by the grant's `installationId` parameter, captured
// at grant time and replayed on every use, so a handle is bound to one
// installation as well as to its caller.

// ---------------------------------------------------------------------------
// App JWT crypto (WebCrypto; workerd-native, no Node dependency)
// ---------------------------------------------------------------------------
//
// The App JWT is deliberately tiny and short-lived: iss = App id, iat backdated
// 60s for clock skew, exp 9 minutes out (GitHub rejects anything over 10). It is
// never persisted — it exists only long enough to obtain an installation token.

const encoder = new TextEncoder();

const RSA_SHA256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

const buf = (view: Uint8Array): BufferSource => view as unknown as BufferSource;

const b64urlFromBytes = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const b64urlJson = (value: unknown): string =>
  b64urlFromBytes(encoder.encode(JSON.stringify(value)));

// Decode a base64 (standard, not url) blob to bytes — PEM bodies are standard.
const bytesFromBase64 = (value: string): Uint8Array => {
  const binary = atob(value.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

// Minimal DER length prefix (short form up to 127, else long form).
const derLength = (length: number): number[] => {
  if (length < 0x80) {
    return [length];
  }
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
};

const derWrap = (tag: number, contents: Uint8Array): Uint8Array => {
  const length = derLength(contents.length);
  const out = new Uint8Array(1 + length.length + contents.length);
  out[0] = tag;
  out.set(length, 1);
  out.set(contents, 1 + length.length);
  return out;
};

// AlgorithmIdentifier for rsaEncryption: SEQUENCE { OID 1.2.840.113549.1.1.1, NULL }.
const RSA_ALGORITHM_IDENTIFIER = new Uint8Array([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]);

// Wrap a PKCS#1 RSAPrivateKey DER into a PKCS#8 PrivateKeyInfo, since WebCrypto
// only imports PKCS#8. GitHub hands out PKCS#1 (`BEGIN RSA PRIVATE KEY`) by
// default, so this lets an operator paste the key GitHub gives them verbatim.
//   PrivateKeyInfo ::= SEQUENCE { version INTEGER 0, algorithm, privateKey OCTET STRING }
const pkcs1ToPkcs8 = (pkcs1: Uint8Array): Uint8Array => {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const privateKey = derWrap(0x04, pkcs1);
  const body = new Uint8Array(version.length + RSA_ALGORITHM_IDENTIFIER.length + privateKey.length);
  body.set(version, 0);
  body.set(RSA_ALGORITHM_IDENTIFIER, version.length);
  body.set(privateKey, version.length + RSA_ALGORITHM_IDENTIFIER.length);
  return derWrap(0x30, body);
};

// Import an RSA private key from a PEM string, accepting both PKCS#8
// (`BEGIN PRIVATE KEY`) and PKCS#1 (`BEGIN RSA PRIVATE KEY`).
export const importAppPrivateKey = async (pem: string): Promise<CryptoKey> => {
  const isPkcs1 = pem.includes("BEGIN RSA PRIVATE KEY");
  const body = pem
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/, "")
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/, "")
    .trim();
  const der = bytesFromBase64(body);
  const pkcs8 = isPkcs1 ? pkcs1ToPkcs8(der) : der;
  return crypto.subtle.importKey("pkcs8", buf(pkcs8), RSA_SHA256, false, ["sign"]);
};

export const APP_JWT_TTL_SECONDS = 540;
const APP_JWT_BACKDATE_SECONDS = 60;

// Mint the App JWT: signs {iat, exp, iss} with RS256. `nowSeconds` is injectable
// for tests. Returns a compact JWS (header.payload.signature).
export const mintAppJwt = async (
  privateKey: CryptoKey,
  appId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> => {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: nowSeconds - APP_JWT_BACKDATE_SECONDS,
    exp: nowSeconds + APP_JWT_TTL_SECONDS,
    iss: appId,
  };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const signature = await crypto.subtle.sign(RSA_SHA256, privateKey, buf(encoder.encode(signingInput)));
  return `${signingInput}.${b64urlFromBytes(new Uint8Array(signature))}`;
};

// ---------------------------------------------------------------------------
// github_app strategy
// ---------------------------------------------------------------------------

// The default {provider, ref} for the numeric App id when a connector does not
// override `appId`. Keeps behaviour unchanged from the env-binding days.
const DEFAULT_APP_ID_REF = { provider: "wrangler-env", ref: "GITHUB_APP_ID" } as const;

// Imported App keys are cached per isolate: PEM import is async and pure.
const importedKeys = new Map<string, Promise<CryptoKey>>();
const appPrivateKey = (pem: string): Promise<CryptoKey> => {
  const cached = importedKeys.get(pem);
  if (cached) {
    return cached;
  }
  const key = importAppPrivateKey(pem);
  importedKeys.set(pem, key);
  return key;
};

type InstallationParams = {
  installationId: string;
  repositories?: string[];
  permissions?: Record<string, string>;
};

// Validate the connector-specific grant/use parameters. installationId is
// mandatory; repositories/permissions are optional GitHub scoping-down fields.
export const installationParams = (params: Record<string, unknown>): InstallationParams => {
  const installationId = params.installationId;
  if (typeof installationId !== "string" || !/^\d{1,20}$/.test(installationId)) {
    throw new ConnectorError(400, "installation_id_invalid");
  }
  const repositories =
    Array.isArray(params.repositories) && params.repositories.every((r) => typeof r === "string")
      ? (params.repositories as string[])
      : undefined;
  const permissions =
    params.permissions && typeof params.permissions === "object"
      ? (params.permissions as Record<string, string>)
      : undefined;
  return { installationId, ...(repositories ? { repositories } : {}), ...(permissions ? { permissions } : {}) };
};

const cacheKey = (connectorId: string, p: InstallationParams): string =>
  `gh:${connectorId}:${p.installationId}:${p.repositories?.join(",") ?? ""}:${
    p.permissions ? JSON.stringify(p.permissions) : ""
  }`;

const resolveInstallationToken = async (ctx: StrategyContext): Promise<ResolvedToken> => {
  const p = installationParams(ctx.params);
  const key = cacheKey(ctx.connector.id, p);
  const cached = ctx.tokenCache.get(key);
  if (cached) {
    return cached;
  }
  const appId = await resolveSecret(ctx.env, ctx.connector.appId ?? DEFAULT_APP_ID_REF);
  const pem = await resolveSecret(ctx.env, ctx.connector.secret);
  const jwt = await mintAppJwt(await appPrivateKey(pem), appId, Math.floor(ctx.now() / 1000));

  const response = await ctx.fetch(
    `https://${ctx.connector.host}/app/installations/${p.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "ragbot-connectors",
      },
      body: JSON.stringify({
        ...(p.repositories ? { repositories: p.repositories } : {}),
        ...(p.permissions ? { permissions: p.permissions } : {}),
      }),
    },
  );
  if (!response.ok) {
    throw new ConnectorError(502, `installation_token_status:${response.status}`);
  }
  const body = (await response.json()) as { token?: unknown; expires_at?: unknown };
  if (typeof body.token !== "string" || body.token.length === 0) {
    throw new ConnectorError(502, "installation_token_missing");
  }
  const expiresAt =
    typeof body.expires_at === "string"
      ? Math.floor(new Date(body.expires_at).getTime() / 1000)
      : undefined;
  const token: ResolvedToken = { value: body.token, tokenType: "Bearer", expiresAt };
  ctx.tokenCache.set(key, token);
  return token;
};

// ---------------------------------------------------------------------------
// App installations (the admin_installations management op)
// ---------------------------------------------------------------------------

// One installation, trimmed to the identifying fields the admin surface needs.
export type AppInstallation = {
  id: number;
  accountLogin: string;
  repositorySelection: string;
};

// List the App's installations: mint the App JWT (the same crypto the strategy
// uses — exported here so the broker never duplicates it) and GET
// /app/installations through the connector's host-allowlisted boundary client.
// Neither the private key nor the JWT leaves the broker; the caller receives
// only the trimmed list.
export const listAppInstallations = async (
  env: Env,
  connector: ConnectorConfig,
  fetch: BoundaryFetch,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<AppInstallation[]> => {
  const appId = await resolveSecret(env, connector.appId ?? DEFAULT_APP_ID_REF);
  const pem = await resolveSecret(env, connector.secret);
  const jwt = await mintAppJwt(await appPrivateKey(pem), appId, nowSeconds);
  const response = await fetch(`https://${connector.host}/app/installations?per_page=100`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "user-agent": "ragbot-connectors",
    },
  });
  if (!response.ok) {
    throw new ConnectorError(502, `installations_status:${response.status}`);
  }
  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) {
    throw new ConnectorError(502, "installations_body");
  }
  return body.flatMap((item): AppInstallation[] => {
    const record = item as {
      id?: unknown;
      account?: { login?: unknown } | null;
      repository_selection?: unknown;
    };
    if (typeof record.id !== "number") {
      return [];
    }
    return [
      {
        id: record.id,
        accountLogin: typeof record.account?.login === "string" ? record.account.login : "",
        repositorySelection:
          typeof record.repository_selection === "string" ? record.repository_selection : "",
      },
    ];
  });
};

const githubAppStrategy: ConnectorStrategy = {
  kind: "github_app",
  prepare: async (ctx) => {
    // Mint the installation token now: validates the App key + installation and
    // warms the cache. The handle expires with the installation token (~1h).
    const token = await resolveInstallationToken(ctx);
    const ttl = (ctx.connector.grantTtlSeconds ?? 3600) + Math.floor(ctx.now() / 1000);
    return { expiresAt: token.expiresAt ? Math.min(ttl, token.expiresAt) : ttl };
  },
  inject: async (ctx) => {
    const token = await resolveInstallationToken(ctx);
    return {
      authorization: `Bearer ${token.value}`,
      accept: "application/vnd.github+json",
      ...(ctx.connector.staticHeaders ?? {}),
    };
  },
  token: resolveInstallationToken,
};

export const githubProvider: ConnectorProvider = {
  name: "github",
  kinds: ["github_app"],
  strategies: [githubAppStrategy],
};
