import type { Client } from "@connectrpc/connect";

import type { DiscoveryService } from "../../discovery/server/discovery/v1/discovery_pb";

// Typed view over the discovery application's GraphQL read model. The
// generated discovery web client carries the session auth; this module only
// shapes queries and parses the JSON payloads.

export type MethodInfo = { name: string; scope: string };
export type ResourceInfo = { name: string; methods: MethodInfo[] };
export type DelegationInfo = { audience: string; scopes: string[] };

export type ApplicationInfo = {
  name: string;
  audience: string;
  endpoint: string;
  description: string;
  provider: string;
  trustZone: string;
  createdAt: number;
  updatedAt: number;
  resources: ResourceInfo[];
  delegations: DelegationInfo[];
};

export type DelegationEdge = { application: string; audience: string; scopes: string[] };

export type SyncState = {
  syncedAt: number;
  applications: number;
  delegations: number;
  methods: number;
};

export const APPLICATIONS_QUERY = `{
  applications {
    name
    audience
    endpoint
    description
    provider
    trustZone
    createdAt
    updatedAt
    resources { name methods { name scope } }
    delegations { audience scopes }
  }
  syncState { syncedAt applications delegations methods }
}`;

export const DELEGATION_GRAPH_QUERY = `{
  delegationGraph { application audience scopes }
  applications { name audience }
}`;

export const queryDiscovery = async <T>(
  client: Client<typeof DiscoveryService>,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> => {
  const response = await client.query({
    query,
    variablesJson: variables ? JSON.stringify(variables) : "",
  });
  if (response.errors.length > 0) {
    throw new Error(response.errors.map((error) => error.message).join("; "));
  }
  return JSON.parse(response.dataJson || "{}") as T;
};
