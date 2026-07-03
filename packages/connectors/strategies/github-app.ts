import { importAppPrivateKey, mintAppJwt } from "../github-jwt";
import { ConnectorError, type ResolvedToken, type StrategyContext, type ConnectorStrategy } from "../types";
import { requireSecret } from "./shared";

// github_app: the reference connector. The broker holds the App private key,
// mints a short-lived App JWT (RS256), and exchanges it for an installation
// access token scoped to one installation, cached until shortly before expiry.
// Neither the private key nor the installation token leaves the broker on the
// fetch path; connector.token can hand back the installation token for the rare
// direct-call case.
//
// The installation is named by the grant's `installationId` parameter, captured
// at grant time and replayed on every use, so a handle is bound to one
// installation as well as to its caller.

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
  const appId = requireSecret(ctx.env, ctx.connector.appIdBinding ?? "GITHUB_APP_ID");
  const pem = requireSecret(ctx.env, ctx.connector.secretBinding);
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

export const githubAppStrategy: ConnectorStrategy = {
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
