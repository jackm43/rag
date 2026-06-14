export type DiscoveryClient = {
  query(input: {
    query: string;
    variables?: Record<string, unknown>;
    operationName?: string;
  }): Promise<{ dataJson: string; errors: Array<{ message: string }> }>;
  sync(_request?: Record<string, never>): Promise<{
    applications: number;
    delegations: number;
    methods: number;
    syncedAt: number;
  }>;
};

export const queryDiscovery = async <T>(
  client: DiscoveryClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> => {
  const response = await client.query({ query, variables });
  if (response.errors.length > 0) {
    throw new Error(response.errors.map((error) => error.message).join("; "));
  }
  return JSON.parse(response.dataJson || "{}") as T;
};
