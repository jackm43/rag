import { logger, type Identity } from "@platy/sdk";

import { d1Store } from "./data";
import { executeQuery } from "./graphql";
import { syncRegistry } from "./sync";
import type { Env } from "./types";

export class HttpServiceError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpServiceError";
    this.status = status;
  }
}

const parseVariables = (variables: unknown): Record<string, unknown> | undefined => {
  if (variables === undefined || variables === null) {
    return undefined;
  }
  if (typeof variables === "string") {
    if (!variables) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(variables) as unknown;
      return parseVariables(parsed);
    } catch {
      throw new HttpServiceError(400, "variables must be valid JSON");
    }
  }
  if (typeof variables !== "object" || Array.isArray(variables)) {
    throw new HttpServiceError(400, "variables must be a JSON object");
  }
  return variables as Record<string, unknown>;
};

export const queryDiscovery = async (
  env: Env,
  input: {
    query?: string;
    variables?: unknown;
    variablesJson?: string;
    operationName?: string;
  },
) => {
  if (!input.query?.trim()) {
    throw new HttpServiceError(400, "query is required");
  }
  const result = await executeQuery(d1Store(env.DB), {
    query: input.query,
    variables: parseVariables(input.variables ?? input.variablesJson),
    operationName: input.operationName || undefined,
  });
  return {
    dataJson: result.dataJson,
    errors: result.errors,
  };
};

export const syncDiscovery = async (env: Env, identity: Identity) => {
  logger.info("discovery_sync_requested", {
    actor: identity.email ?? identity.subject,
  });
  const state = await syncRegistry(env, d1Store(env.DB), identity);
  return {
    applications: state.applications,
    delegations: state.delegations,
    methods: state.methods,
    syncedAt: state.syncedAt,
  };
};
