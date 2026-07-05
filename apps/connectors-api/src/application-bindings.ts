export type ConnectorsApiSecurityScheme = "cfAccess";

export type ConnectorsApiRouteBinding = {
  path: string;
  method: "GET";
  operationId: string;
  summary: string;
  description?: string;
  security?: readonly ConnectorsApiSecurityScheme[];
  parameters?: readonly unknown[];
  requestBody?: unknown;
  responses: Record<string, unknown>;
};

export const CONNECTORS_API_APPLICATION = {
  title: "ragbot connectors api",
  description:
    "Machine-facing HTTP surface over the credential broker. Behind a Cloudflare Access perimeter (service token or Access JWT); every request, including health and openapi, is Access-gated. Read management operations are proxied to the connectors broker over its service binding — the broker itself stays binding-only.",
  version: "1.0.0",
  serverUrl: "https://connectors.jsmunro.me",
} as const;

export const CONNECTORS_API_SECURITY_SCHEMES = {
  cfAccess: {
    type: "http",
    scheme: "bearer",
    description: "Cloudflare Access perimeter token (service token or Access JWT).",
  },
} as const satisfies Record<ConnectorsApiSecurityScheme, unknown>;

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

export const CONNECTORS_API_ROUTE_BINDINGS = [
  {
    path: "/openapi.json",
    method: "GET",
    operationId: "connectorsApiOpenApiJson",
    summary: "Connectors API generated OpenAPI document",
    security: ["cfAccess"],
    responses: {
      "200": jsonObjectResponse("Generated OpenAPI document."),
    },
  },
  {
    path: "/health",
    method: "GET",
    operationId: "connectorsApiHealth",
    summary: "Connectors API service health",
    security: ["cfAccess"],
    responses: {
      "200": jsonObjectResponse("Health snapshot."),
    },
  },
  {
    path: "/",
    method: "GET",
    operationId: "connectorsApiIndex",
    summary: "Connectors API text landing response",
    security: ["cfAccess"],
    responses: {
      "200": { description: "Text response." },
    },
  },
  {
    path: "/api/connectors",
    method: "GET",
    operationId: "listConnectors",
    summary: "List connectors",
    description:
      "Read-only management listing of the broker's connectors and their status. Proxied to the connectors broker's admin_list operation over its service binding; no secret material is ever returned.",
    security: ["cfAccess"],
    responses: {
      "200": jsonObjectResponse("Connector list."),
      "401": { description: "Missing or invalid Access token." },
      "403": { description: "Caller not authorized for the management operation." },
      "502": { description: "Broker upstream error." },
    },
  },
] as const satisfies readonly ConnectorsApiRouteBinding[];
