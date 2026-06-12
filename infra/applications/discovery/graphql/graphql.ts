import type { Client } from "@connectrpc/connect";

import type { DiscoveryService } from "../server/discovery/v1/discovery_service_pb";

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
