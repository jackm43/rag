export type MetadataSecurityScheme = "metadataQueryToken";

export type MetadataRouteBinding = {
  path: string;
  method: "GET" | "POST";
  operationId: string;
  summary: string;
  security?: MetadataSecurityScheme;
  requestBody?: unknown;
  responses: Record<string, unknown>;
};

export const METADATA_APPLICATION = {
  title: "ragbot metadata",
  description:
    "GraphQL metadata application for resolving registered application shapes, authorization metadata, and artifact attestation state.",
  version: "1.0.0",
  serverUrl: "https://metadata.jsmunro.me",
} as const;

export const METADATA_SECURITY_SCHEMES = {
  metadataQueryToken: {
    type: "http",
    scheme: "bearer",
  },
} as const satisfies Record<MetadataSecurityScheme, unknown>;

const jsonObjectResponse = (description: string) => ({
  description,
  content: {
    "application/json": {
      schema: {
        type: "object",
        additionalProperties: true,
      },
    },
  },
});

export const METADATA_ROUTE_BINDINGS = [
  {
    path: "/openapi.json",
    method: "GET",
    operationId: "metadataOpenApiJson",
    summary: "Metadata generated OpenAPI document",
    responses: {
      "200": jsonObjectResponse("Generated OpenAPI document."),
    },
  },
  {
    path: "/health",
    method: "GET",
    operationId: "metadataHealth",
    summary: "Metadata service health",
    responses: {
      "200": jsonObjectResponse("Health snapshot."),
    },
  },
  {
    path: "/.well-known/metadata-configuration",
    method: "GET",
    operationId: "metadataConfiguration",
    summary: "Metadata resolver discovery",
    responses: {
      "200": jsonObjectResponse("Metadata resolver discovery document."),
    },
  },
  {
    path: "/graphql",
    method: "POST",
    operationId: "metadataGraphql",
    summary: "GraphQL metadata resolver",
    security: "metadataQueryToken",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["query"],
            properties: {
              query: { type: "string" },
              variables: { type: "object", additionalProperties: true },
              operationName: { type: "string" },
            },
          },
        },
      },
    },
    responses: {
      "200": jsonObjectResponse("GraphQL response."),
      "401": { description: "Missing or invalid metadata query token." },
      "415": { description: "Request body is not JSON." },
    },
  },
] as const satisfies readonly MetadataRouteBinding[];
