export type MethodView = {
  name: string;
  scope: string;
};

export type ResourceView = {
  name: string;
  methods: MethodView[];
};

export type DelegationView = {
  audience: string;
  scopes: string[];
};

export type ApplicationView = {
  name: string;
  audience: string;
  endpoint: string;
  description: string;
  provider: string;
  trustZone: string;
  createdAt: number;
  updatedAt: number;
  resources: ResourceView[];
  delegations: DelegationView[];
};

export type DelegationEdgeView = {
  application: string;
  audience: string;
  scopes: string[];
};

export type GatewayEndpointsView = {
  tokenExchange: string;
  tokenRevoke: string;
  introspect: string;
  discovery: string;
  jwks: string;
};

export type GatewayView = {
  issuer: string;
  jwksUri: string;
  endpoints: GatewayEndpointsView | null;
};

export type SyncStateView = {
  syncedAt: number;
  applications: number;
  delegations: number;
  methods: number;
};

// RegistrySnapshot is the full gateway registry as one ingestable value; the
// sync routine maps the Discover RPC response into it and the store replaces
// the read model atomically.
export type RegistrySnapshot = {
  issuer: string;
  jwksUri: string;
  endpoints: GatewayEndpointsView | null;
  applications: Array<{
    name: string;
    audience: string;
    endpoint: string;
    description: string;
    provider: string;
    trustZone: string;
    impersonationAccessClientId: string;
    providerOauthClientId: string;
    providerOauthScopes: string[];
    trustBoundary: unknown;
    access: unknown;
    createdAt: number;
    updatedAt: number;
    resources: ResourceView[];
    delegations: DelegationView[];
  }>;
};

// DiscoveryStore is the read model behind the GraphQL resolvers; the worker
// binds it to D1, tests bind it to fixtures.
export interface DiscoveryStore {
  listApplications(): Promise<ApplicationView[]>;
  getApplication(name: string): Promise<ApplicationView | null>;
  listDelegationEdges(): Promise<DelegationEdgeView[]>;
  gateway(): Promise<GatewayView | null>;
  syncState(): Promise<SyncStateView | null>;
  replace(snapshot: RegistrySnapshot): Promise<SyncStateView>;
}

type ApplicationRow = {
  name: string;
  audience: string;
  endpoint: string;
  description: string;
  provider: string;
  trust_zone: string;
  created_at: number;
  updated_at: number;
};

type MethodRow = {
  application: string;
  resource: string;
  name: string;
  scope: string;
};

type DelegationRow = {
  application: string;
  audience: string;
  scopes: string;
};

type GatewayRow = {
  issuer: string;
  jwks_uri: string;
  endpoints: string;
};

type SyncStateRow = {
  synced_at: number;
  applications: number;
  delegations: number;
  methods: number;
};

// Generated protobuf messages carry $typeName markers; keep the stored JSON
// plain.
const toJson = (value: unknown): string =>
  JSON.stringify(value, (key, nested) => (key.startsWith("$") ? undefined : nested));

const parseJson = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const composeApplications = (
  applications: ApplicationRow[],
  methods: MethodRow[],
  delegations: DelegationRow[],
): ApplicationView[] =>
  applications.map((application) => {
    const resources = new Map<string, ResourceView>();
    for (const method of methods) {
      if (method.application !== application.name) {
        continue;
      }
      const resource = resources.get(method.resource) ?? { name: method.resource, methods: [] };
      resource.methods.push({ name: method.name, scope: method.scope });
      resources.set(method.resource, resource);
    }
    return {
      name: application.name,
      audience: application.audience,
      endpoint: application.endpoint,
      description: application.description,
      provider: application.provider,
      trustZone: application.trust_zone,
      createdAt: application.created_at,
      updatedAt: application.updated_at,
      resources: [...resources.values()],
      delegations: delegations
        .filter((delegation) => delegation.application === application.name)
        .map((delegation) => ({
          audience: delegation.audience,
          scopes: parseJson<string[]>(delegation.scopes, []),
        })),
    };
  });

export const d1Store = (db: D1Database): DiscoveryStore => {
  const loadApplications = async (filter?: string): Promise<ApplicationView[]> => {
    const where = filter === undefined ? "" : " WHERE name = ?1";
    const bindArgs = filter === undefined ? [] : [filter];
    const methodWhere = filter === undefined ? "" : " WHERE application = ?1";
    const [applications, methods, delegations] = await Promise.all([
      db
        .prepare(
          `SELECT name, audience, endpoint, description, provider, trust_zone, created_at, updated_at FROM discovery_applications${where} ORDER BY name`,
        )
        .bind(...bindArgs)
        .all<ApplicationRow>(),
      db
        .prepare(
          `SELECT application, resource, name, scope FROM discovery_methods${methodWhere} ORDER BY application, resource, name`,
        )
        .bind(...bindArgs)
        .all<MethodRow>(),
      db
        .prepare(
          `SELECT application, audience, scopes FROM discovery_delegations${methodWhere} ORDER BY application, audience`,
        )
        .bind(...bindArgs)
        .all<DelegationRow>(),
    ]);
    return composeApplications(
      applications.results ?? [],
      methods.results ?? [],
      delegations.results ?? [],
    );
  };

  return {
    listApplications: () => loadApplications(),

    getApplication: async (name) => {
      const [application] = await loadApplications(name);
      return application ?? null;
    },

    listDelegationEdges: async () => {
      const rows = await db
        .prepare(
          "SELECT application, audience, scopes FROM discovery_delegations ORDER BY application, audience",
        )
        .all<DelegationRow>();
      return (rows.results ?? []).map((row) => ({
        application: row.application,
        audience: row.audience,
        scopes: parseJson<string[]>(row.scopes, []),
      }));
    },

    gateway: async () => {
      const row = await db
        .prepare("SELECT issuer, jwks_uri, endpoints FROM discovery_gateway WHERE id = 1")
        .first<GatewayRow>();
      if (!row) {
        return null;
      }
      return {
        issuer: row.issuer,
        jwksUri: row.jwks_uri,
        endpoints: parseJson<GatewayEndpointsView | null>(row.endpoints, null),
      };
    },

    syncState: async () => {
      const row = await db
        .prepare(
          "SELECT synced_at, applications, delegations, methods FROM discovery_sync_state WHERE id = 1",
        )
        .first<SyncStateRow>();
      if (!row) {
        return null;
      }
      return {
        syncedAt: row.synced_at,
        applications: row.applications,
        delegations: row.delegations,
        methods: row.methods,
      };
    },

    replace: async (snapshot) => {
      const syncedAt = Math.floor(Date.now() / 1000);
      let delegationCount = 0;
      let methodCount = 0;
      const statements: D1PreparedStatement[] = [
        db.prepare("DELETE FROM discovery_methods"),
        db.prepare("DELETE FROM discovery_resources"),
        db.prepare("DELETE FROM discovery_delegations"),
        db.prepare("DELETE FROM discovery_applications"),
      ];
      for (const application of snapshot.applications) {
        statements.push(
          db
            .prepare(
              "INSERT INTO discovery_applications (name, audience, endpoint, description, provider, trust_zone, trust_boundary, access, impersonation_access_client_id, provider_oauth_client_id, provider_oauth_scopes, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            )
            .bind(
              application.name,
              application.audience,
              application.endpoint,
              application.description,
              application.provider,
              application.trustZone,
              toJson(application.trustBoundary ?? {}),
              toJson(application.access ?? {}),
              application.impersonationAccessClientId,
              application.providerOauthClientId,
              JSON.stringify(application.providerOauthScopes),
              application.createdAt,
              application.updatedAt,
            ),
        );
        for (const resource of application.resources) {
          statements.push(
            db
              .prepare("INSERT INTO discovery_resources (application, name) VALUES (?1, ?2)")
              .bind(application.name, resource.name),
          );
          for (const method of resource.methods) {
            methodCount += 1;
            statements.push(
              db
                .prepare(
                  "INSERT INTO discovery_methods (application, resource, name, scope) VALUES (?1, ?2, ?3, ?4)",
                )
                .bind(application.name, resource.name, method.name, method.scope),
            );
          }
        }
        for (const delegation of application.delegations) {
          delegationCount += 1;
          statements.push(
            db
              .prepare(
                "INSERT INTO discovery_delegations (application, audience, scopes) VALUES (?1, ?2, ?3)",
              )
              .bind(application.name, delegation.audience, JSON.stringify(delegation.scopes)),
          );
        }
      }
      statements.push(
        db
          .prepare(
            "INSERT INTO discovery_gateway (id, issuer, jwks_uri, endpoints, updated_at) VALUES (1, ?1, ?2, ?3, ?4) ON CONFLICT (id) DO UPDATE SET issuer = ?1, jwks_uri = ?2, endpoints = ?3, updated_at = ?4",
          )
          .bind(snapshot.issuer, snapshot.jwksUri, JSON.stringify(snapshot.endpoints ?? {}), syncedAt),
      );
      const state: SyncStateView = {
        syncedAt,
        applications: snapshot.applications.length,
        delegations: delegationCount,
        methods: methodCount,
      };
      statements.push(
        db
          .prepare(
            "INSERT INTO discovery_sync_state (id, synced_at, applications, delegations, methods) VALUES (1, ?1, ?2, ?3, ?4) ON CONFLICT (id) DO UPDATE SET synced_at = ?1, applications = ?2, delegations = ?3, methods = ?4",
          )
          .bind(state.syncedAt, state.applications, state.delegations, state.methods),
      );
      // D1 batches run as one implicit transaction: the read model swaps
      // atomically or not at all.
      await db.batch(statements);
      return state;
    },
  };
};
