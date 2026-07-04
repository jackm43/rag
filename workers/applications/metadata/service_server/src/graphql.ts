import { verifyArtifactAttestation } from "../../../../../packages/attest/client";
import type { Env } from "../../../../../packages/contracts/types";
import {
  REGISTRY_APPLICATION_ID_PATTERN,
  type RegistryApplicationMetadata,
  type RegistryScaffold,
} from "../../../../../packages/registry/types";

export type MetadataGraphQlError = {
  message: string;
  path?: string[];
  extensions?: Record<string, unknown>;
};

export type MetadataGraphQlResponse = {
  data?: Record<string, unknown> | null;
  errors?: MetadataGraphQlError[];
};

export type MetadataGraphQlRequest = {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const applicationRegistry = (env: Env) => {
  if (!env.REGISTRY_APPLICATIONS) {
    return null;
  }
  return env.REGISTRY_APPLICATIONS.get(env.REGISTRY_APPLICATIONS.idFromName("applications"));
};

const repositoryName = (env: Env): string =>
  `${env.REGISTRY_GITHUB_OWNER ?? "jackm"}/${env.REGISTRY_GITHUB_REPO ?? "rag"}`;

const isApplicationMetadata = (value: unknown): value is RegistryApplicationMetadata => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    REGISTRY_APPLICATION_ID_PATTERN.test(value.id) &&
    typeof value.displayName === "string" &&
    typeof value.ownerDiscordId === "string" &&
    typeof value.ownerAccessSub === "string" &&
    typeof value.zone === "string" &&
    typeof value.requestedAt === "string" &&
    typeof value.status === "string" &&
    Array.isArray(value.targets) &&
    value.targets.every((target) => typeof target === "string") &&
    Array.isArray(value.operations) &&
    value.operations.every((operation) => typeof operation === "string") &&
    Array.isArray(value.routes)
  );
};

const getStringVariable = (
  variables: Record<string, unknown> | undefined,
  name: string,
): string | null => {
  const value = variables?.[name];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
};

const getBooleanVariable = (
  variables: Record<string, unknown> | undefined,
  name: string,
  fallback: boolean,
): boolean => {
  const value = variables?.[name];
  return typeof value === "boolean" ? value : fallback;
};

const getNumberVariable = (
  variables: Record<string, unknown> | undefined,
  name: string,
  fallback: number,
): number => {
  const value = variables?.[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};

const resolveAttestations = async (
  env: Env,
  applicationId: string,
  productionOnly: boolean,
): Promise<Record<string, unknown>> => {
  const registry = applicationRegistry(env);
  if (!registry) {
    return { repository: repositoryName(env), productionReady: false, artifacts: [] };
  }
  const scaffold = await registry.getScaffoldResult(applicationId) as RegistryScaffold | null;
  if (!scaffold || !Array.isArray(scaffold.artifacts)) {
    return { repository: repositoryName(env), productionReady: false, artifacts: [] };
  }
  const repository = repositoryName(env);
  const artifacts = await Promise.all(scaffold.artifacts.map(async (artifact) => ({
    path: artifact.path,
    sha256: artifact.sha256,
    attestation: await verifyArtifactAttestation(env, {
      repository,
      path: artifact.path,
      sha256: artifact.sha256,
      productionOnly,
    }),
  })));
  return {
    repository,
    productionReady: artifacts.length > 0 && artifacts.every((artifact) => artifact.attestation.ok),
    artifacts,
  };
};

const resolveApplication = async (
  env: Env,
  id: string,
  includeAttestations: boolean,
  productionOnly: boolean,
): Promise<Record<string, unknown> | null> => {
  if (!REGISTRY_APPLICATION_ID_PATTERN.test(id)) {
    return null;
  }
  const registry = applicationRegistry(env);
  if (!registry) {
    throw new Error("Application registry is not bound");
  }
  const application = await registry.get(id);
  if (!isApplicationMetadata(application)) {
    return null;
  }
  return {
    ...application,
    ...(includeAttestations ? { attestations: await resolveAttestations(env, id, productionOnly) } : {}),
  };
};

const resolveApplications = async (
  env: Env,
  limit: number,
): Promise<RegistryApplicationMetadata[]> => {
  const registry = applicationRegistry(env);
  if (!registry) {
    throw new Error("Application registry is not bound");
  }
  const applications = await registry.list();
  return applications.filter(isApplicationMetadata).slice(0, Math.max(0, Math.min(limit, 100)));
};

const resolveAuthorizationShape = async (
  env: Env,
  variables: Record<string, unknown> | undefined,
): Promise<Record<string, unknown> | null> => {
  const id = getStringVariable(variables, "id") ?? getStringVariable(variables, "applicationId");
  if (!id) {
    throw new Error("authorizationShape requires id or applicationId");
  }
  const includeAttestations = getBooleanVariable(variables, "includeAttestations", true);
  const productionOnly = getBooleanVariable(variables, "productionOnly", true);
  const application = await resolveApplication(env, id, includeAttestations, productionOnly);
  if (!application) {
    return null;
  }
  return {
    application,
    service: {
      service: application.id,
      zone: application.zone,
      targets: application.targets,
      operations: application.operations,
      routes: application.routes,
    },
  };
};

export const executeMetadataGraphQl = async (
  request: MetadataGraphQlRequest,
  env: Env,
): Promise<MetadataGraphQlResponse> => {
  const variables = request.variables;
  const query = request.query;
  const data: Record<string, unknown> = {};

  if (/\bauthorizationShape\b/.test(query)) {
    data.authorizationShape = await resolveAuthorizationShape(env, variables);
  }
  if (/\bapplication\s*\(/.test(query)) {
    const id = getStringVariable(variables, "id") ?? getStringVariable(variables, "applicationId");
    if (!id) {
      throw new Error("application requires id or applicationId");
    }
    data.application = await resolveApplication(
      env,
      id,
      getBooleanVariable(variables, "includeAttestations", false),
      getBooleanVariable(variables, "productionOnly", true),
    );
  }
  if (/\bapplications\b/.test(query)) {
    data.applications = await resolveApplications(env, getNumberVariable(variables, "limit", 50));
  }

  if (Object.keys(data).length === 0) {
    return {
      data: null,
      errors: [{ message: "Unsupported metadata query", extensions: { code: "UNSUPPORTED_QUERY" } }],
    };
  }
  return { data };
};
