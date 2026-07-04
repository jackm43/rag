import type { EntityJson } from "@cedar-policy/cedar-wasm/web";
import { authorize, type AuthorizationRequest, type Decision } from "./authorize";

type MetadataApplication = {
  id: string;
  zone?: string;
  targets?: unknown[];
  operations?: unknown[];
  attestations?: {
    productionReady?: unknown;
    repository?: unknown;
  };
};

type MetadataGraphQlResponse = {
  data?: {
    authorizationShape?: {
      application?: MetadataApplication | null;
      service?: {
        service?: unknown;
        zone?: unknown;
        targets?: unknown[];
        operations?: unknown[];
      } | null;
    } | null;
    applications?: MetadataApplication[];
  } | null;
  errors?: Array<{ message?: unknown }>;
};

type AuthorizationShape =
  NonNullable<NonNullable<MetadataGraphQlResponse["data"]>["authorizationShape"]> | null | undefined;

export type FetchAuthorizationMetadataOptions = {
  endpoint: string;
  token: string;
  applicationId: string;
  includeAttestations?: boolean;
  productionOnly?: boolean;
  limit?: number;
  fetcher?: typeof fetch;
};

export type AuthorizeWithMetadataOptions = {
  entities?: EntityJson[];
  metadata?: Omit<FetchAuthorizationMetadataOptions, "applicationId"> & {
    applicationId?: string;
  };
};

const GRAPHQL_QUERY = `
  query AuthorizationMetadata(
    $id: String!
    $includeAttestations: Boolean!
    $productionOnly: Boolean!
    $limit: Int!
  ) {
    authorizationShape(id: $id, includeAttestations: $includeAttestations, productionOnly: $productionOnly)
    applications(limit: $limit)
  }
`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const entityRef = (type: "Application" | "Service", id: string) => ({
  __entity: { type, id },
});

const normalizeGraphQlEndpoint = (endpoint: string): string => {
  const url = new URL(endpoint);
  if (url.pathname === "/" || url.pathname === "") {
    url.pathname = "/graphql";
  }
  return url.toString();
};

const applicationIdFromRequest = (request: AuthorizationRequest): string | null => {
  if (request.resource.type === "Application") {
    return request.resource.id;
  }
  if (request.resource.type === "Service") {
    const [applicationId] = request.resource.id.split(":");
    return applicationId || null;
  }
  return null;
};

const asApplication = (value: unknown): MetadataApplication | null =>
  isRecord(value) && typeof value.id === "string" ? value as MetadataApplication : null;

const mergeApplication = (
  applications: Map<string, MetadataApplication>,
  application: MetadataApplication | null,
) => {
  if (application) {
    applications.set(application.id, application);
  }
};

export const authorizationMetadataToEntities = (
  shape: AuthorizationShape,
  applicationsInput: unknown,
): EntityJson[] => {
  const applications = new Map<string, MetadataApplication>();
  for (const application of Array.isArray(applicationsInput) ? applicationsInput : []) {
    mergeApplication(applications, asApplication(application));
  }
  mergeApplication(applications, asApplication(shape?.application));

  const values = [...applications.values()];
  const entities: EntityJson[] = [];
  for (const application of values) {
    const targets = stringList(application.targets);
    const operations = stringList(application.operations);
    const productionReady = application.attestations?.productionReady;
    const repository = application.attestations?.repository;
    entities.push({
      uid: { type: "Application", id: application.id },
      attrs: {
        zone: typeof application.zone === "string" ? application.zone : "",
        plane: "data",
        targets: targets.map((target) => entityRef("Application", target)),
        operations,
        ...(typeof productionReady === "boolean" ? { productionReady } : {}),
        ...(typeof repository === "string" ? { attestationRepository: repository } : {}),
      },
      parents: [],
    });
  }

  for (const application of values) {
    const operations = stringList(application.operations);
    const clients = values
      .filter((candidate) => stringList(candidate.targets).includes(application.id))
      .map((candidate) => entityRef("Application", candidate.id));
    for (const operation of operations) {
      entities.push({
        uid: { type: "Service", id: `${application.id}:${operation}` },
        attrs: {
          application: entityRef("Application", application.id),
          zone: typeof application.zone === "string" ? application.zone : "",
          plane: "data",
          operation,
          clients,
        },
        parents: [],
      });
    }
  }

  return entities;
};

export const fetchAuthorizationMetadataEntities = async (
  options: FetchAuthorizationMetadataOptions,
): Promise<EntityJson[]> => {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(normalizeGraphQlEndpoint(options.endpoint), {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: GRAPHQL_QUERY,
      variables: {
        id: options.applicationId,
        includeAttestations: options.includeAttestations ?? true,
        productionOnly: options.productionOnly ?? true,
        limit: options.limit ?? 100,
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Metadata authorization query failed with HTTP ${response.status}`);
  }
  const payload = await response.json() as MetadataGraphQlResponse;
  if (payload.errors && payload.errors.length > 0) {
    throw new Error(
      `Metadata authorization query failed: ${payload.errors.map((error) => String(error.message)).join("; ")}`,
    );
  }
  return authorizationMetadataToEntities(
    payload.data?.authorizationShape ?? null,
    payload.data?.applications ?? [],
  );
};

export const authorizeWithMetadata = async (
  request: AuthorizationRequest,
  options: AuthorizeWithMetadataOptions = {},
): Promise<Decision> => {
  const entities = [...(options.entities ?? [])];
  if (options.metadata) {
    const applicationId = options.metadata.applicationId ?? applicationIdFromRequest(request);
    if (!applicationId) {
      throw new Error("Metadata-backed authorization requires an application resource");
    }
    entities.push(...await fetchAuthorizationMetadataEntities({
      ...options.metadata,
      applicationId,
    }));
  }
  return authorize(request, entities);
};
