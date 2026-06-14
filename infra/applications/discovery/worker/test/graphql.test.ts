import test from "node:test";
import assert from "node:assert/strict";

import {
  d1Store,
  type ApplicationView,
  type DelegationEdgeView,
  type DiscoveryStore,
  type GatewayView,
  type RegistrySnapshot,
  type SyncStateView,
} from "../src/data.ts";
import { DISCOVERY_SCHEMA_SDL, executeQuery } from "../src/graphql.ts";
import { snapshotFromDiscovery } from "../src/sync.ts";

const ragbot: ApplicationView = {
  name: "ragbot",
  audience: "ragbot",
  endpoint: "https://ragbot.example.com",
  description: "Discord bot admin services",
  provider: "cloudflare",
  trustZone: "tier2",
  createdAt: 1700000000,
  updatedAt: 1700000100,
  resources: [
    {
      name: "ConfigService",
      methods: [
        { name: "ListConfig", scope: "ragbot/ConfigService.ListConfig" },
        { name: "UpdateConfig", scope: "ragbot/ConfigService.UpdateConfig" },
      ],
    },
  ],
  delegations: [{ audience: "idp", scopes: [] }],
};

const deploy: ApplicationView = {
  name: "deploy",
  audience: "deploy",
  endpoint: "https://deploy.example.com",
  description: "Worker deployment service",
  provider: "cloudflare",
  trustZone: "tier2",
  createdAt: 1700000200,
  updatedAt: 1700000300,
  resources: [
    {
      name: "DeployService",
      methods: [{ name: "ListWorkers", scope: "deploy/DeployService.ListWorkers" }],
    },
  ],
  delegations: [
    { audience: "cloudflare", scopes: ["cloudflare/WorkerService.ListWorkers"] },
  ],
};

const edges: DelegationEdgeView[] = [
  { application: "deploy", audience: "cloudflare", scopes: ["cloudflare/WorkerService.ListWorkers"] },
  { application: "ragbot", audience: "idp", scopes: [] },
];

const gateway: GatewayView = {
  issuer: "https://auth-gateway.example.com",
  jwksUri: "https://auth-gateway.example.com/.well-known/jwks.json",
  endpoints: {
    tokenExchange: "https://auth-gateway.example.com/oauth/token",
    tokenRevoke: "https://auth-gateway.example.com/oauth/revoke",
    introspect: "https://auth-gateway.example.com/platform/gateway/v1/identity/introspections",
    discovery: "https://auth-gateway.example.com/api/discovery",
    jwks: "https://auth-gateway.example.com/.well-known/jwks.json",
  },
};

const syncState: SyncStateView = {
  syncedAt: 1700000400,
  applications: 2,
  delegations: 2,
  methods: 3,
};

const fixtureStore = (overrides: Partial<DiscoveryStore> = {}): DiscoveryStore => ({
  listApplications: async () => [deploy, ragbot],
  getApplication: async (name) => [deploy, ragbot].find((app) => app.name === name) ?? null,
  listDelegationEdges: async () => edges,
  gateway: async () => gateway,
  syncState: async () => syncState,
  replace: async () => syncState,
  ...overrides,
});

test("schema SDL is exported and parseable source", () => {
  assert.ok(DISCOVERY_SCHEMA_SDL.includes("type Query"));
  assert.ok(DISCOVERY_SCHEMA_SDL.includes("delegationGraph: [DelegationEdge!]!"));
});

test("applications query returns nested resources, methods, and delegations", async () => {
  const result = await executeQuery(fixtureStore(), {
    query:
      "{ applications { name audience resources { name methods { name scope } } delegations { audience scopes } } }",
  });

  assert.deepEqual(result.errors, []);
  const data = JSON.parse(result.dataJson) as {
    applications: Array<{
      name: string;
      resources: Array<{ name: string; methods: Array<{ scope: string }> }>;
      delegations: Array<{ audience: string }>;
    }>;
  };
  assert.deepEqual(
    data.applications.map((app) => app.name),
    ["deploy", "ragbot"],
  );
  assert.equal(data.applications[1].resources[0].name, "ConfigService");
  assert.equal(
    data.applications[1].resources[0].methods[0].scope,
    "ragbot/ConfigService.ListConfig",
  );
  assert.equal(data.applications[0].delegations[0].audience, "cloudflare");
});

test("application query resolves by variable and returns null for unknown names", async () => {
  const query = "query App($name: String!) { application(name: $name) { name endpoint } }";

  const found = await executeQuery(fixtureStore(), {
    query,
    variables: { name: "ragbot" },
    operationName: "App",
  });
  assert.deepEqual(found.errors, []);
  assert.deepEqual(JSON.parse(found.dataJson), {
    application: { name: "ragbot", endpoint: "https://ragbot.example.com" },
  });

  const missing = await executeQuery(fixtureStore(), { query, variables: { name: "nope" } });
  assert.deepEqual(missing.errors, []);
  assert.deepEqual(JSON.parse(missing.dataJson), { application: null });
});

test("delegationGraph query returns application to audience edges with scopes", async () => {
  const result = await executeQuery(fixtureStore(), {
    query: "{ delegationGraph { application audience scopes } }",
  });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(JSON.parse(result.dataJson), { delegationGraph: edges });
});

test("gateway and syncState queries return metadata", async () => {
  const result = await executeQuery(fixtureStore(), {
    query:
      "{ gateway { issuer jwksUri endpoints { tokenExchange jwks } } syncState { syncedAt applications delegations methods } }",
  });

  assert.deepEqual(result.errors, []);
  const data = JSON.parse(result.dataJson) as {
    gateway: { issuer: string; endpoints: { tokenExchange: string } };
    syncState: SyncStateView;
  };
  assert.equal(data.gateway.issuer, gateway.issuer);
  assert.equal(data.gateway.endpoints.tokenExchange, gateway.endpoints?.tokenExchange);
  assert.deepEqual(data.syncState, syncState);
});

test("validation failures come back as errors with locations, never thrown", async () => {
  const result = await executeQuery(fixtureStore(), { query: "{ nonsense }" });

  assert.equal(result.dataJson, "");
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /Cannot query field "nonsense"/);
  assert.ok(result.errors[0].locations.length > 0);
  assert.equal(result.errors[0].locations[0].line, 1);
});

test("syntax failures come back as errors", async () => {
  const result = await executeQuery(fixtureStore(), { query: "{ applications {" });

  assert.equal(result.dataJson, "");
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /Syntax Error/);
});

test("resolver failures are mapped to errors with the field path", async () => {
  const store = fixtureStore({
    listDelegationEdges: async () => {
      throw new Error("read model unavailable");
    },
  });
  const result = await executeQuery(store, {
    query: "{ delegationGraph { application } syncState { applications } }",
  });

  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /read model unavailable/);
  assert.deepEqual(result.errors[0].path, ["delegationGraph"]);
  // delegationGraph is non-null, so the error propagates to the root: data
  // is null rather than absent, and the response is still a normal RPC reply.
  assert.deepEqual(JSON.parse(result.dataJson), null);
});

type FakeStatement = { sql: string; args: unknown[] };

const createFakeDb = (rows: {
  applications?: unknown[];
  methods?: unknown[];
  delegations?: unknown[];
  gateway?: unknown;
  syncState?: unknown;
  onBatch?: (statements: FakeStatement[]) => void;
}) => ({
  prepare: (sql: string) => {
    const statement = (args: unknown[]) => ({
      sql,
      args,
      all: async () => {
        if (sql.includes("FROM discovery_applications")) {
          return { results: rows.applications ?? [] };
        }
        if (sql.includes("FROM discovery_methods")) {
          return { results: rows.methods ?? [] };
        }
        if (sql.includes("FROM discovery_delegations")) {
          return { results: rows.delegations ?? [] };
        }
        return { results: [] };
      },
      first: async () => {
        if (sql.includes("FROM discovery_gateway")) {
          return rows.gateway ?? null;
        }
        if (sql.includes("FROM discovery_sync_state")) {
          return rows.syncState ?? null;
        }
        return null;
      },
    });
    return {
      ...statement([]),
      bind: (...args: unknown[]) => statement(args),
    };
  },
  batch: async (statements: FakeStatement[]) => {
    rows.onBatch?.(statements);
    return [];
  },
});

test("d1Store composes applications from rows", async () => {
  const db = createFakeDb({
    applications: [
      {
        name: "ragbot",
        audience: "ragbot",
        endpoint: "https://ragbot.example.com",
        description: "bot",
        provider: "cloudflare",
        trust_zone: "tier2",
        created_at: 1,
        updated_at: 2,
      },
    ],
    methods: [
      { application: "ragbot", resource: "ConfigService", name: "ListConfig", scope: "ragbot/ConfigService.ListConfig" },
    ],
    delegations: [{ application: "ragbot", audience: "idp", scopes: '["idp/DiscoveryService.Discover"]' }],
  });

  const store = d1Store(db as never);
  const applications = await store.listApplications();

  assert.equal(applications.length, 1);
  assert.equal(applications[0].trustZone, "tier2");
  assert.deepEqual(applications[0].resources, [
    { name: "ConfigService", methods: [{ name: "ListConfig", scope: "ragbot/ConfigService.ListConfig" }] },
  ]);
  assert.deepEqual(applications[0].delegations, [
    { audience: "idp", scopes: ["idp/DiscoveryService.Discover"] },
  ]);
});

test("d1Store replace swaps the read model in one batch and reports counts", async () => {
  const batches: FakeStatement[][] = [];
  const db = createFakeDb({ onBatch: (statements) => batches.push(statements) });
  const snapshot: RegistrySnapshot = snapshotFromDiscovery({
    issuer: "https://auth-gateway.example.com",
    jwksUri: "https://auth-gateway.example.com/.well-known/jwks.json",
    endpoints: { tokenExchange: "https://auth-gateway.example.com/exchange" },
    applications: [
      {
        name: "ragbot",
        audience: "ragbot",
        endpoint: "https://ragbot.example.com",
        description: "bot",
        provider: "cloudflare",
        trustZone: "tier2",
        impersonationAccessClientId: "",
        providerOauthClientId: "",
        providerOauthScopes: [],
        createdAt: 1n,
        updatedAt: 2n,
        resources: [
          {
            name: "ConfigService",
            methods: [
              { name: "ListConfig", scope: "ragbot/ConfigService.ListConfig" },
              { name: "UpdateConfig", scope: "ragbot/ConfigService.UpdateConfig" },
            ],
          },
        ],
        delegations: [{ audience: "idp", scopes: [] }],
      },
    ],
  });

  const store = d1Store(db as never);
  const state = await store.replace(snapshot);

  assert.equal(state.applications, 1);
  assert.equal(state.delegations, 1);
  assert.equal(state.methods, 2);
  assert.ok(state.syncedAt > 0);

  assert.equal(batches.length, 1);
  const statements = batches[0];
  assert.ok(statements[0].sql.startsWith("DELETE FROM discovery_methods"));
  const inserts = statements.filter((statement) => statement.sql.startsWith("INSERT"));
  // 1 application + 1 resource + 2 methods + 1 delegation + gateway + sync state.
  assert.equal(inserts.length, 7);
  const gatewayInsert = inserts.find((statement) => statement.sql.includes("discovery_gateway"));
  assert.equal(gatewayInsert?.args[0], "https://auth-gateway.example.com");
});
