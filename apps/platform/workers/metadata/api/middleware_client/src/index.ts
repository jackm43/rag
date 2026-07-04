import { createEdgeWorker, jsonResponse, prepareApplicationHop } from "@rag/service-kit/edge";
import { encodeMetadataQueryEnvelope } from "../../../../../contracts";
import type { Env } from "../../../../../contracts";
import { isRecord } from "@rag/contracts-core";
import { timingSafeEqual } from "@rag/ingress/timing-safe-equal";
import { logger } from "@rag/logger";
import {
  METADATA_MANIFEST,
  MetadataService,
  type MetadataGraphQlRequest,
  type MetadataGraphQlResponse,
} from "../../../service_server/src";
import { OPENAPI } from "./openapi";

export { MetadataService };

const graphQl = (status: number, body: MetadataGraphQlResponse): Response =>
  jsonResponse(status, body);

const encoder = new TextEncoder();
const timingSafeStringEqual = (left: string, right: string): boolean =>
  timingSafeEqual(encoder.encode(left), encoder.encode(right));

const authorizeQuery = (request: Request, env: Env): Response | null => {
  if (!env.METADATA_QUERY_TOKEN) {
    logger.error("metadata_query_token_unset", {});
    return graphQl(500, {
      data: null,
      errors: [{ message: "Metadata resolver is not configured", extensions: { code: "MISCONFIGURED" } }],
    });
  }
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  if (!timingSafeStringEqual(token, env.METADATA_QUERY_TOKEN)) {
    return graphQl(401, {
      data: null,
      errors: [{ message: "Unauthorized", extensions: { code: "UNAUTHORIZED" } }],
    });
  }
  return null;
};

const parseGraphQlRequest = async (request: Request): Promise<MetadataGraphQlRequest | Response> => {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return graphQl(415, {
      data: null,
      errors: [{ message: "GraphQL requests must use application/json", extensions: { code: "UNSUPPORTED_MEDIA_TYPE" } }],
    });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return graphQl(400, {
      data: null,
      errors: [{ message: "Invalid JSON", extensions: { code: "BAD_REQUEST" } }],
    });
  }
  if (!isRecord(body) || typeof body.query !== "string") {
    return graphQl(400, {
      data: null,
      errors: [{ message: "Missing GraphQL query", extensions: { code: "BAD_REQUEST" } }],
    });
  }
  return {
    query: body.query,
    ...(isRecord(body.variables) ? { variables: body.variables } : {}),
    ...(typeof body.operationName === "string" ? { operationName: body.operationName } : {}),
  };
};

const invokeMetadata = async (
  request: MetadataGraphQlRequest,
  env: Env,
): Promise<Response> => {
  if (!env.METADATA_SERVICE) {
    return graphQl(500, {
      data: null,
      errors: [{ message: "Metadata service is not configured", extensions: { code: "MISCONFIGURED" } }],
    });
  }
  const message = await prepareApplicationHop({
    env,
    self: "metadata",
    target: "metadata",
    subject: "metadata-query",
    manifest: METADATA_MANIFEST,
    envelope: encodeMetadataQueryEnvelope(
      {
        kind: "metadata.query",
        query: request.query,
        variablesJson: JSON.stringify(request.variables ?? {}),
        ...(request.operationName ? { operationName: request.operationName } : {}),
      },
      { source: "worker" },
    ),
  });
  const result = await env.METADATA_SERVICE.invoke(message);
  return graphQl(result.status, result.body as MetadataGraphQlResponse);
};

const handleGraphQl = async (request: Request, env: Env): Promise<Response> => {
  const authError = authorizeQuery(request, env);
  if (authError) {
    return authError;
  }
  const parsed = await parseGraphQlRequest(request);
  if (parsed instanceof Response) {
    return parsed;
  }
  try {
    return await invokeMetadata(parsed, env);
  } catch (error) {
    logger.warn("metadata_service_invoke_failed", { error: String(error) });
    return graphQl(200, {
      data: null,
      errors: [{ message: "Metadata resolver failed", extensions: { code: "RESOLUTION_FAILED" } }],
    });
  }
};

export default createEdgeWorker<Env>({
  service: "metadata",
  manifest: METADATA_MANIFEST,
  openapi: OPENAPI,
  routes: [
    {
      match: "/.well-known/metadata-configuration",
      methods: {
        GET: (request) => {
          const origin = new URL(request.url).origin;
          return jsonResponse(200, {
            issuer: origin,
            graphql_endpoint: `${origin}/graphql`,
            supported_queries: ["application", "applications", "authorizationShape"],
          });
        },
      },
    },
    {
      match: "/graphql",
      methods: { POST: (request, env) => handleGraphQl(request, env) },
    },
  ],
});
