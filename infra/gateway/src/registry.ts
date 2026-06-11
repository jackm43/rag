import type { Env } from "./types";

export type RegisteredMethod = {
  name: string;
  scope: string;
};

export type RegisteredResource = {
  name: string;
  methods: RegisteredMethod[];
};

export type TrustBoundary = {
  provider: string;
  accountId: string;
  teamId: string;
  teamName: string;
  teamDomain: string;
};

export type ApplicationAccess = {
  allowedGroups: string[];
  allowedIdps: string[];
  postureRequired: boolean;
  trustZone: string;
};

export type RegisteredApplication = {
  name: string;
  audience: string;
  endpoint: string;
  description: string;
  resources: RegisteredResource[];
  provider: string;
  trustBoundary: TrustBoundary;
  access: ApplicationAccess;
  createdAt: number;
  updatedAt: number;
};

export type AccessPolicyMFAConfig = {
  sessionDuration?: string;
};

export type AccessPolicySpec = {
  approvalRequired?: boolean;
  purposeJustificationRequired?: boolean;
  sessionDuration?: string;
  isolationRequired?: boolean;
  requirePosture?: boolean;
  mfaConfig?: AccessPolicyMFAConfig;
};

export type ZeroTrustGatewaySettings = {
  tlsDecrypt?: boolean;
  inspectionMode?: string;
};

export type ZeroTrustDeviceSettings = {
  gatewayProxyEnabled?: boolean;
  gatewayUdpProxyEnabled?: boolean;
};

export type PostureCheckSpec = {
  type?: string;
  name?: string;
};

export type ZeroTrustPostureSpec = {
  checks?: PostureCheckSpec[];
};

export type ZeroTrustSettings = {
  gateway?: ZeroTrustGatewaySettings;
  devices?: ZeroTrustDeviceSettings;
  posture?: ZeroTrustPostureSpec;
};

export type EnrollPolicy = {
  staff?: {
    idpTypes?: string[];
    requirePosture?: boolean;
  };
  contractor?: {
    idpTypes?: string[];
    requireWarpOrRbi?: boolean;
  };
  onSuccess?: {
    grantGroup?: string;
    gatewaySession?: boolean;
  };
  onRevoke?: {
    requireReenroll?: boolean;
  };
};

export type TrustZoneSpec = {
  name: string;
  role?: string;
  description?: string;
  teamLabel?: string;
  groups?: string[];
  accessPolicy?: AccessPolicySpec;
  enroll?: EnrollPolicy;
};

export type OrganizationPolicy = {
  organization: { name: string; provider: string };
  zeroTrust?: ZeroTrustSettings;
  trustZones: TrustZoneSpec[];
};

export type ProviderConfig = {
  boundary: TrustBoundary;
  identityProviders: { id: string; name: string; type: string }[];
  groups: { id: string; name: string }[];
  emailAllowlist: string[];
  posture: { enabled: boolean; ruleId: string; checks: { type: string }[] };
  organization?: OrganizationPolicy;
};

type ApplicationRow = {
  name: string;
  audience: string;
  endpoint: string;
  description: string;
  resources: string;
  provider: string;
  trust_boundary: string;
  access: string;
  created_at: number;
  updated_at: number;
};

const emptyTrustBoundary = (): TrustBoundary => ({
  provider: "",
  accountId: "",
  teamId: "",
  teamName: "",
  teamDomain: "",
});

const emptyAccess = (): ApplicationAccess => ({
  allowedGroups: [],
  allowedIdps: [],
  postureRequired: false,
  trustZone: "tier2",
});

const parseTrustBoundary = (raw: string): TrustBoundary => {
  if (!raw) {
    return emptyTrustBoundary();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<TrustBoundary>;
    return {
      provider: parsed.provider ?? "",
      accountId: parsed.accountId ?? "",
      teamId: parsed.teamId ?? "",
      teamName: parsed.teamName ?? "",
      teamDomain: parsed.teamDomain ?? "",
    };
  } catch {
    return emptyTrustBoundary();
  }
};

const parseAccess = (raw: string): ApplicationAccess => {
  if (!raw) {
    return emptyAccess();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ApplicationAccess>;
    return {
      allowedGroups: parsed.allowedGroups ?? [],
      allowedIdps: parsed.allowedIdps ?? [],
      postureRequired: parsed.postureRequired ?? false,
      trustZone: parsed.trustZone ?? "tier2",
    };
  } catch {
    return emptyAccess();
  }
};

const fromRow = (row: ApplicationRow): RegisteredApplication => ({
  name: row.name,
  audience: row.audience,
  endpoint: row.endpoint,
  description: row.description,
  resources: JSON.parse(row.resources) as RegisteredResource[],
  provider: row.provider ?? "",
  trustBoundary: parseTrustBoundary(row.trust_boundary ?? ""),
  access: parseAccess(row.access ?? ""),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const getApplication = async (env: Env, name: string): Promise<RegisteredApplication | null> => {
  const row = await env.DB.prepare("SELECT * FROM idp_applications WHERE name = ?")
    .bind(name)
    .first<ApplicationRow>();
  return row ? fromRow(row) : null;
};

export const getApplicationByAudience = async (
  env: Env,
  audience: string,
): Promise<RegisteredApplication | null> => {
  const row = await env.DB.prepare("SELECT * FROM idp_applications WHERE audience = ?")
    .bind(audience)
    .first<ApplicationRow>();
  return row ? fromRow(row) : null;
};

export const listApplications = async (env: Env): Promise<RegisteredApplication[]> => {
  const result = await env.DB.prepare("SELECT * FROM idp_applications ORDER BY name").run<ApplicationRow>();
  return (result.results ?? []).map(fromRow);
};

export const upsertApplication = async (
  env: Env,
  app: Pick<
    RegisteredApplication,
    "name" | "endpoint" | "description" | "resources" | "provider" | "trustBoundary" | "access"
  >,
): Promise<RegisteredApplication> => {
  await env.DB.prepare(
    `INSERT INTO idp_applications (name, audience, endpoint, description, resources, provider, trust_boundary, access)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       endpoint = excluded.endpoint,
       description = excluded.description,
       resources = excluded.resources,
       provider = excluded.provider,
       trust_boundary = excluded.trust_boundary,
       access = excluded.access,
       updated_at = unixepoch()`,
  )
    .bind(
      app.name,
      app.name,
      app.endpoint,
      app.description,
      JSON.stringify(app.resources),
      app.provider,
      JSON.stringify(app.trustBoundary),
      JSON.stringify(app.access),
    )
    .run();
  const stored = await getApplication(env, app.name);
  if (!stored) {
    throw new Error("application upsert failed");
  }
  return stored;
};

export const deleteApplication = async (env: Env, name: string): Promise<boolean> => {
  const result = await env.DB.prepare("DELETE FROM idp_applications WHERE name = ? AND name != 'idp'")
    .bind(name)
    .run();
  return (result.meta?.changes ?? 0) > 0;
};

export const secretHash = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const secretHashMatches = async (candidate: string, expected: string): Promise<boolean> => {
  const candidateHash = await secretHash(candidate);
  if (candidateHash.length !== expected.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < candidateHash.length; index += 1) {
    difference |= candidateHash.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
};

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const createServiceClient = async (
  env: Env,
  application: string,
): Promise<{ clientId: string; clientSecret: string }> => {
  const clientId = `svc_${application}_${base64url(crypto.getRandomValues(new Uint8Array(9)))}`;
  const clientSecret = base64url(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare(
    "INSERT INTO idp_service_clients (client_id, application, secret_hash) VALUES (?, ?, ?)",
  )
    .bind(clientId, application, await secretHash(clientSecret))
    .run();
  return { clientId, clientSecret };
};

export const hasServiceClient = async (env: Env, application: string): Promise<boolean> => {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS clients FROM idp_service_clients WHERE application = ?",
  )
    .bind(application)
    .first<{ clients: number }>();
  return (row?.clients ?? 0) > 0;
};

export const verifyServiceClient = async (
  env: Env,
  clientId: string,
  clientSecret: string,
): Promise<string | null> => {
  const row = await env.DB.prepare(
    "SELECT application, secret_hash FROM idp_service_clients WHERE client_id = ?",
  )
    .bind(clientId)
    .first<{ application: string; secret_hash: string }>();
  if (!row) {
    return null;
  }
  return (await secretHashMatches(clientSecret, row.secret_hash)) ? row.application : null;
};

export type DelegationGrant = {
  audience: string;
  scopes: string[];
};

export const setDelegations = async (
  env: Env,
  application: string,
  delegations: DelegationGrant[],
): Promise<void> => {
  await env.DB.prepare("DELETE FROM idp_delegations WHERE application = ?").bind(application).run();
  for (const delegation of delegations) {
    await env.DB.prepare(
      "INSERT INTO idp_delegations (application, audience, scopes) VALUES (?, ?, ?)",
    )
      .bind(application, delegation.audience, JSON.stringify(delegation.scopes))
      .run();
  }
};

export const listDelegations = async (env: Env, application: string): Promise<DelegationGrant[]> => {
  const result = await env.DB.prepare(
    "SELECT audience, scopes FROM idp_delegations WHERE application = ? ORDER BY audience",
  )
    .bind(application)
    .run<{ audience: string; scopes: string }>();
  return (result.results ?? []).map((row) => ({
    audience: row.audience,
    scopes: JSON.parse(row.scopes) as string[],
  }));
};

export const delegationFor = async (
  env: Env,
  application: string,
  audience: string,
): Promise<DelegationGrant | null> => {
  const row = await env.DB.prepare(
    "SELECT audience, scopes FROM idp_delegations WHERE application = ? AND audience = ?",
  )
    .bind(application, audience)
    .first<{ audience: string; scopes: string }>();
  return row ? { audience: row.audience, scopes: JSON.parse(row.scopes) as string[] } : null;
};

export const audit = async (env: Env, actor: string, action: string, detail: string) => {
  await env.DB.prepare("INSERT INTO idp_audit_log (actor, action, detail) VALUES (?, ?, ?)")
    .bind(actor, action, detail)
    .run();
};

const emptyProviderConfig = (): ProviderConfig => ({
  boundary: emptyTrustBoundary(),
  identityProviders: [],
  groups: [],
  emailAllowlist: [],
  posture: { enabled: false, ruleId: "", checks: [] },
});

export const getProviderConfig = async (env: Env): Promise<ProviderConfig> => {
  const row = await env.DB.prepare("SELECT config FROM idp_provider_config WHERE id = 1").first<{ config: string }>();
  if (!row?.config) {
    return emptyProviderConfig();
  }
  try {
    return JSON.parse(row.config) as ProviderConfig;
  } catch {
    return emptyProviderConfig();
  }
};

export const upsertProviderConfig = async (env: Env, config: ProviderConfig): Promise<ProviderConfig> => {
  await env.DB.prepare(
    `INSERT INTO idp_provider_config (id, config, updated_at)
     VALUES (1, ?, unixepoch())
     ON CONFLICT(id) DO UPDATE SET
       config = excluded.config,
       updated_at = unixepoch()`,
  )
    .bind(JSON.stringify(config))
    .run();
  return getProviderConfig(env);
};
