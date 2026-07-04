import { createClient, ensureRegistered } from "../../../../../../packages/auth";
import { encodeMetadataQueryEnvelope } from "../../../../../../packages/contracts";
import type { Env } from "../../../../../../packages/contracts/types";
import { logger } from "../../../../../../packages/logger";
import {
  METADATA_MANIFEST,
  MetadataService,
  type MetadataGraphQlRequest,
  type MetadataGraphQlResponse,
} from "../../../service_server/src";
import { OPENAPI } from "./openapi";

export { MetadataService };

const encoder = new TextEncoder();

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const graphQl = (status: number, body: MetadataGraphQlResponse): Response => json(status, body);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const timingSafeEqual = (left: string, right: string): boolean => {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    diff |= leftBytes[index] ^ rightBytes[index];
  }
  return diff === 0;
};

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
  if (!timingSafeEqual(token, env.METADATA_QUERY_TOKEN)) {
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
  await ensureRegistered(env, METADATA_MANIFEST);
  const envelope = encodeMetadataQueryEnvelope(
    {
      kind: "metadata.query",
      query: request.query,
      variablesJson: JSON.stringify(request.variables ?? {}),
      ...(request.operationName ? { operationName: request.operationName } : {}),
    },
    { source: "worker" },
  );
  const message = await createClient({
    env,
    self: "metadata",
    context: { subject: "metadata-query" },
    transportTrust: "application",
  }).to("metadata").prepare(envelope);
  const result = await env.METADATA_SERVICE.invoke(message);
  return graphQl(result.status, result.body as MetadataGraphQlResponse);
};

const handleGraphQl = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  }
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    ctx.waitUntil(ensureRegistered(env, METADATA_MANIFEST));
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json(200, { ok: true, service: "metadata" });
    }

    if (request.method === "GET" && url.pathname === "/openapi.json") {
      return json(200, OPENAPI);
    }

    if (request.method === "GET" && url.pathname === "/.well-known/metadata-configuration") {
      return json(200, {
        issuer: url.origin,
        graphql_endpoint: `${url.origin}/graphql`,
        supported_queries: ["application", "applications", "authorizationShape"],
      });
    }

    if (url.pathname === "/graphql") {
      return handleGraphQl(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};
