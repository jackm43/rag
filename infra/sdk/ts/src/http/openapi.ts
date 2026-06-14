import type { RouteContract } from "./types";

export interface OpenApiInfo {
  title: string;
  version: string;
  description?: string;
}

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: OpenApiInfo;
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: {
    securitySchemes: Record<string, unknown>;
  };
}

export interface OpenApiOperation {
  operationId: string;
  summary?: string;
  description?: string;
  tags?: string[];
  security?: Record<string, string[]>[];
  responses: Record<string, unknown>;
}

export function buildOpenApiDocument(info: OpenApiInfo, routes: RouteContract[]): OpenApiDocument {
  const document: OpenApiDocument = {
    openapi: "3.1.0",
    info,
    paths: {},
    components: {
      securitySchemes: {
        gatewayBearer: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
    },
  };

  for (const route of routes) {
    const path = route.path;
    const method = route.method.toLowerCase();
    document.paths[path] ??= {};
    document.paths[path][method] = {
      operationId: route.operationId,
      ...(route.summary ? { summary: route.summary } : {}),
      ...(route.description ? { description: route.description } : {}),
      ...(route.tags ? { tags: route.tags } : {}),
      ...(route.auth === "none" ? {} : { security: [{ gatewayBearer: route.scopes ?? [] }] }),
      responses: {
        "200": {
          description: "Successful response",
        },
      },
    };
  }

  return document;
}

