import { WorkerEntrypoint } from "cloudflare:workers";

import { createServiceServer, ensureRegistered } from "../../../../../packages/auth";
import { decodeMetadataQueryEnvelope } from "../../../../../packages/contracts";
import type { Env, MetadataQueryResult, ServiceMessageBytes } from "../../../../../packages/contracts/types";
import { errorMessage, logger } from "../../../../../packages/logger";
import { executeMetadataGraphQl } from "./graphql";
import { METADATA_MANIFEST } from "./manifest";

const server = (env: Env) => createServiceServer({
  self: "metadata",
  expectedIssuers: ["metadata"],
  env,
  operations: METADATA_MANIFEST.operations,
});

const graphQlError = (status: number, message: string, code: string): MetadataQueryResult => ({
  status,
  body: {
    data: null,
    errors: [{ message, extensions: { code } }],
  },
});

const parseVariables = (value: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
};

export const handleMetadataQuery = async (
  env: Env,
  message: ServiceMessageBytes,
): Promise<MetadataQueryResult> => {
  await ensureRegistered(env, METADATA_MANIFEST);
  const request = await server(env).receive(message, decodeMetadataQueryEnvelope, "binding");
  if (!request) {
    return graphQlError(403, "Metadata request denied", "FORBIDDEN");
  }
  const variables = parseVariables(request.payload.variablesJson);
  if (!variables) {
    return graphQlError(400, "Invalid GraphQL variables", "BAD_REQUEST");
  }
  try {
    return {
      status: 200,
      body: await executeMetadataGraphQl({
        query: request.payload.query,
        variables,
        ...(request.payload.operationName ? { operationName: request.payload.operationName } : {}),
      }, env),
    };
  } catch (error) {
    logger.warn("metadata_graphql_failed", { error: errorMessage(error) });
    return graphQlError(200, errorMessage(error), "RESOLUTION_FAILED");
  }
};

export class MetadataService extends WorkerEntrypoint<Env> {
  async invoke(message: ServiceMessageBytes): Promise<MetadataQueryResult> {
    return handleMetadataQuery(this.env, message);
  }
}
