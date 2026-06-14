import { calculateJwkThumbprint, type JWK } from "jose";

import {
  hasScope,
  logger,
  principalFromIdentity,
  type Identity,
} from "@platy/sdk";
import { signToken } from "./keys";
import {
  audit,
  createServiceClient,
  deleteApplication,
  getApplication,
  getApplicationByAudience,
  getProviderConfig,
  hasServiceClient,
  listApplications,
  listDelegations,
  setDelegations,
  upsertApplication,
  upsertProviderConfig,
  type ProviderConfig,
} from "./registry";
import { exchangeProviderAccessToken } from "./provider-oauth";
import { getTrace, listTraces, streamSpans } from "./traces";
import { applicationView, providerConfigView } from "./services";
import type { Env } from "./types";

const TOKEN_LIFETIME_SECONDS = 300;

export class HttpServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpServiceError";
  }
}

const issuer = (env: Env) => env.GATEWAY_ISSUER.replace(/\/$/, "");

const nestActChain = (chain: string[]): Record<string, unknown> | undefined => {
  let act: Record<string, unknown> | undefined;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    act = act ? { sub: chain[index], act } : { sub: chain[index] };
  }
  return act;
};

const requireAllowedUser = (env: Env, identity: Identity) => {
  const email = identity.email ?? "";
  const allowed = (env.ALLOWED_EMAILS ?? "jack@jsmunro.me")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (!email || !allowed.includes(email.toLowerCase())) {
    throw new HttpServiceError(403, "forbidden");
  }
};

export const introspectCaller = (env: Env, identity: Identity) => {
  requireAllowedUser(env, identity);
  const scope = "idp/IdentityService.Introspect";
  if (!hasScope(identity, scope)) {
    logger.warn("request_denied", {
      method: "GET /platform/gateway/v1/identity/introspections",
      actor: identity.email ?? identity.subject,
      reason: "scope",
      scope,
    });
    throw new HttpServiceError(403, `missing required scope ${scope}`);
  }
  const principal = principalFromIdentity(identity);
  return {
    principal: {
      kind: principal.kind,
      sub: principal.sub,
      email: principal.email ?? "",
      act: principal.act ?? [],
    },
    scopes: identity.scopes,
  };
};

export const exchangeProviderToken = async (
  env: Env,
  headers: Headers,
  application: string,
  subjectToken?: string,
) => {
  const token = subjectToken ?? (() => {
    const auth = headers.get("authorization") ?? "";
    return auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  })();
  if (!token) {
    throw new HttpServiceError(401, "subject token is required");
  }
  if (!application) {
    throw new HttpServiceError(400, "application is required");
  }
  const exchanged = await exchangeProviderAccessToken(env, token, application);
  if (!exchanged.accessToken) {
    return {
      accessToken: "",
      expiresIn: 0,
      authorizeUrl: exchanged.authorizeUrl ?? "",
    };
  }
  return {
    accessToken: exchanged.accessToken,
    expiresIn: exchanged.expiresIn,
    authorizeUrl: "",
  };
};

type RegisterApplicationInput = {
  name?: string;
  endpoint?: string;
  description?: string;
  resources?: Array<{
    name?: string;
    methods?: Array<{ name?: string; scope?: string }>;
  }>;
  delegations?: Array<{ audience?: string; scopes?: string[] }>;
  provider?: string;
  trustBoundary?: {
    provider?: string;
    accountId?: string;
    teamId?: string;
    teamName?: string;
    teamDomain?: string;
  };
  access?: {
    allowedGroups?: string[];
    allowedIdps?: string[];
    postureRequired?: boolean;
    trustZone?: string;
  };
  trustZone?: string;
  impersonationAccessClientId?: string;
  providerOauthClientId?: string;
  providerOauthScopes?: string[];
};

export const registerApplication = async (
  env: Env,
  identity: Identity,
  request: RegisterApplicationInput,
) => {
  if (!request.name || !/^[a-z][a-z0-9-]*$/.test(request.name)) {
    throw new HttpServiceError(400, "application name must be lowercase alphanumeric");
  }
  for (const delegation of request.delegations ?? []) {
    if (!delegation.audience) {
      throw new HttpServiceError(400, "delegation audience is required");
    }
    for (const scope of delegation.scopes ?? []) {
      if (scope !== `${delegation.audience}/*` && !scope.startsWith(`${delegation.audience}/`)) {
        throw new HttpServiceError(400, `delegation scope ${scope} is outside audience ${delegation.audience}`);
      }
    }
  }
  const providerConfig = await getProviderConfig(env);
  const postureRequired =
    request.access?.postureRequired ?? (providerConfig.posture.enabled && providerConfig.posture.ruleId !== "");
  const application = await upsertApplication(env, {
    name: request.name,
    endpoint: request.endpoint ?? "",
    description: request.description ?? "",
    resources: (request.resources ?? []).map((resource) => ({
      name: resource.name ?? "",
      methods: (resource.methods ?? []).map((method) => ({
        name: method.name ?? "",
        scope: method.scope || `${request.name}/${resource.name}.${method.name}`,
      })),
    })),
    provider: request.provider ?? providerConfig.boundary.provider,
    trustBoundary: {
      provider: request.trustBoundary?.provider ?? providerConfig.boundary.provider,
      accountId: request.trustBoundary?.accountId ?? providerConfig.boundary.accountId,
      teamId: request.trustBoundary?.teamId ?? providerConfig.boundary.teamId,
      teamName: request.trustBoundary?.teamName ?? providerConfig.boundary.teamName,
      teamDomain: request.trustBoundary?.teamDomain ?? providerConfig.boundary.teamDomain,
    },
    access: {
      allowedGroups: request.access?.allowedGroups ?? [],
      allowedIdps: request.access?.allowedIdps ?? [],
      postureRequired,
      trustZone: request.trustZone || request.access?.trustZone || "tier2",
    },
    impersonationAccessClientId: request.impersonationAccessClientId ?? "",
    providerOauthClientId: request.providerOauthClientId ?? "",
    providerOauthScopes: request.providerOauthScopes ?? [],
  });
  const delegations = (request.delegations ?? []).map((delegation) => ({
    audience: delegation.audience ?? "",
    scopes: delegation.scopes ?? [],
  }));
  await setDelegations(env, application.name, delegations);
  const credential = (await hasServiceClient(env, application.name))
    ? { clientId: "", clientSecret: "" }
    : await createServiceClient(env, application.name);
  await audit(env, identity.email ?? identity.subject, "register_application", application.name);
  return {
    application: applicationView(application, delegations),
    credential,
  };
};

export const getApplicationRecord = async (env: Env, name: string) => {
  const application = await getApplication(env, name);
  if (!application) {
    throw new HttpServiceError(404, `unknown application ${name}`);
  }
  return {
    application: applicationView(application, await listDelegations(env, application.name)),
  };
};

export const listApplicationRecords = async (env: Env) => ({
  applications: await Promise.all(
    (await listApplications(env)).map(async (app) =>
      applicationView(app, await listDelegations(env, app.name)),
    ),
  ),
});

export const deleteApplicationRecord = async (env: Env, identity: Identity, name: string) => {
  const deleted = await deleteApplication(env, name);
  if (deleted) {
    await audit(env, identity.email ?? identity.subject, "delete_application", name);
  }
  return { deleted };
};

export const registerServiceClient = async (env: Env, identity: Identity, name: string) => {
  const application = await getApplication(env, name);
  if (!application) {
    throw new HttpServiceError(404, `unknown application ${name}`);
  }
  const credential = await createServiceClient(env, application.name);
  await audit(env, identity.email ?? identity.subject, "register_client", application.name);
  return { credential };
};

export const upsertProviderConfigRecord = async (
  env: Env,
  identity: Identity,
  configJson: string,
) => {
  let parsed: ProviderConfig;
  try {
    parsed = JSON.parse(configJson) as ProviderConfig;
  } catch {
    throw new HttpServiceError(400, "config_json must be valid provider config JSON");
  }
  const stored = await upsertProviderConfig(env, parsed);
  await audit(env, identity.email ?? identity.subject, "upsert_provider_config", stored.boundary.teamName);
  return { config: providerConfigView(stored) };
};

export const getProviderConfigRecord = async (env: Env) => ({
  config: providerConfigView(await getProviderConfig(env)),
});

export const listTraceSummaries = async (env: Env, limit: number) => ({
  traces: await listTraces(env, limit > 0 ? limit : 25),
});

export const getTraceDetail = async (env: Env, traceId: string) => {
  const spans = await getTrace(env, traceId);
  if (!spans) {
    throw new HttpServiceError(404, `trace ${traceId} not found`);
  }
  return { traceId, spans };
};

export async function* streamTraceEvents(env: Env, signal?: AbortSignal) {
  const POLL_MS = 1500;
  const MAX_TICKS = 30;
  let cursor = Math.floor(Date.now() / 1000) - 5;
  const seen = new Set<string>();
  for (let tick = 0; tick < MAX_TICKS && !signal?.aborted; tick += 1) {
    const rows = await streamSpans(env, cursor);
    for (const row of rows) {
      if (seen.has(row.span.spanId)) {
        continue;
      }
      seen.add(row.span.spanId);
      cursor = Math.max(cursor, row.createdAt);
      yield { traceId: row.traceId, span: row.span };
    }
    if (seen.size > 4000) {
      seen.clear();
      cursor = Math.floor(Date.now() / 1000);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

type RegisterClientIdentityInput = {
  application?: string;
  instanceId?: string;
  publicJwk?: string;
  kind?: string;
};

export const registerClientIdentity = async (
  env: Env,
  identity: Identity,
  request: RegisterClientIdentityInput,
) => {
  const application = (request.application ?? "").trim();
  if (!/^[a-z][a-z0-9-]*$/.test(application)) {
    throw new HttpServiceError(400, "application must be a registered name");
  }
  if (!(await getApplicationByAudience(env, application))) {
    throw new HttpServiceError(404, `unknown application ${application}`);
  }
  const immediateActor = identity.actorChain[0];
  if (immediateActor && !immediateActor.startsWith(`svc_${application}_`)) {
    throw new HttpServiceError(403, `actor ${immediateActor} cannot register identities for ${application}`);
  }
  const instanceId = /^[A-Za-z0-9_-]{1,64}$/.test(request.instanceId ?? "")
    ? request.instanceId!
    : crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  let jkt = "";
  if (request.publicJwk) {
    try {
      jkt = await calculateJwkThumbprint(JSON.parse(request.publicJwk) as JWK, "sha256");
    } catch {
      throw new HttpServiceError(400, "public_jwk is not a valid JWK");
    }
  }
  const kind = (request.kind ?? "").trim() || "client";
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + TOKEN_LIFETIME_SECONDS * 144;
  await env.DB.prepare(
    `INSERT OR REPLACE INTO idp_client_identities
       (instance_id, application, subject, email, kind, jkt, public_jwk, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      instanceId,
      application,
      identity.subject,
      identity.email ?? "",
      kind,
      jkt,
      request.publicJwk ?? "",
      now,
      expiresAt,
    )
    .run();
  const token = await signToken(env, {
    iss: issuer(env),
    sub: identity.subject,
    aud: application,
    email: identity.email ?? undefined,
    kind,
    instance: instanceId,
    iat: now,
    exp: expiresAt,
    jti: crypto.randomUUID(),
    ...(identity.actorChain.length > 0 ? { act: nestActChain(identity.actorChain) } : {}),
    ...(jkt ? { cnf: { jkt } } : {}),
  });
  await audit(
    env,
    identity.email ?? identity.subject,
    "register_client_identity",
    `${application}:${instanceId}`,
  );
  return {
    identityToken: token,
    expiresIn: expiresAt - now,
    identity: {
      instanceId,
      application,
      subject: identity.subject,
      email: identity.email ?? "",
      kind,
      jkt,
      createdAt: now,
      expiresAt,
    },
  };
};

export const listClientIdentityRecords = async (
  env: Env,
  identity: Identity,
  application: string,
) => {
  const trimmed = application.trim();
  const immediateActor = identity.actorChain[0];
  if (immediateActor) {
    if (!trimmed || !immediateActor.startsWith(`svc_${trimmed}_`)) {
      throw new HttpServiceError(
        403,
        `actor ${immediateActor} may only list identities for its own application`,
      );
    }
  }
  const rows = trimmed
    ? await env.DB.prepare(
      "SELECT * FROM idp_client_identities WHERE application = ? ORDER BY created_at DESC LIMIT 100",
    )
      .bind(trimmed)
      .run<Record<string, string | number>>()
    : await env.DB.prepare(
      "SELECT * FROM idp_client_identities ORDER BY created_at DESC LIMIT 100",
    ).run<Record<string, string | number>>();
  return {
    identities: rows.results.map((row) => ({
      instanceId: String(row.instance_id),
      application: String(row.application),
      subject: String(row.subject),
      email: String(row.email),
      kind: String(row.kind),
      jkt: String(row.jkt),
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
    })),
  };
};
