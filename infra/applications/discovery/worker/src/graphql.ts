import { buildSchema, graphql, type GraphQLError } from "graphql";

import type { DiscoveryStore } from "./data";

// The schema lives in source so other components (Go client, console) can
// read the SDL straight from the code.
export const DISCOVERY_SCHEMA_SDL = `
type Method {
  name: String!
  scope: String!
}

type Resource {
  name: String!
  methods: [Method!]!
}

type Delegation {
  audience: String!
  scopes: [String!]!
}

type Application {
  name: String!
  audience: String!
  endpoint: String!
  description: String!
  provider: String!
  trustZone: String!
  createdAt: Int!
  updatedAt: Int!
  resources: [Resource!]!
  delegations: [Delegation!]!
}

type DelegationEdge {
  application: String!
  audience: String!
  scopes: [String!]!
}

type GatewayEndpoints {
  tokenExchange: String!
  tokenRevoke: String!
  introspect: String!
  discovery: String!
  jwks: String!
}

type Gateway {
  issuer: String!
  jwksUri: String!
  endpoints: GatewayEndpoints
}

type SyncState {
  syncedAt: Int!
  applications: Int!
  delegations: Int!
  methods: Int!
}

type Query {
  applications: [Application!]!
  application(name: String!): Application
  delegationGraph: [DelegationEdge!]!
  gateway: Gateway
  syncState: SyncState
}
`;

const schema = buildSchema(DISCOVERY_SCHEMA_SDL);

export type QueryErrorLocation = {
  line: number;
  column: number;
};

export type QueryError = {
  message: string;
  path: string[];
  locations: QueryErrorLocation[];
};

export type QueryResult = {
  dataJson: string;
  errors: QueryError[];
};

export type QueryInput = {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
};

const mapError = (error: GraphQLError): QueryError => ({
  message: error.message,
  path: (error.path ?? []).map(String),
  locations: (error.locations ?? []).map((location) => ({
    line: location.line,
    column: location.column,
  })),
});

const rootValue = (store: DiscoveryStore) => ({
  applications: () => store.listApplications(),
  application: ({ name }: { name: string }) => store.getApplication(name),
  delegationGraph: () => store.listDelegationEdges(),
  gateway: () => store.gateway(),
  syncState: () => store.syncState(),
});

// executeQuery runs one GraphQL request against the read model. Syntax,
// validation, and resolver failures all come back in the errors list — the
// transport never sees them as RPC failures.
export const executeQuery = async (
  store: DiscoveryStore,
  request: QueryInput,
): Promise<QueryResult> => {
  const result = await graphql({
    schema,
    source: request.query,
    rootValue: rootValue(store),
    variableValues: request.variables,
    operationName: request.operationName,
  });
  return {
    dataJson: result.data === undefined ? "" : JSON.stringify(result.data),
    errors: (result.errors ?? []).map(mapError),
  };
};
