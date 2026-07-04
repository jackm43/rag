export type GatewaySecurityScheme = "controlToken";

export type GatewayRouteBinding = {
  path: string;
  method: "GET" | "POST";
  operationId: string;
  summary: string;
  description?: string;
  security?: GatewaySecurityScheme;
  requestBody?: unknown;
  responses: Record<string, unknown>;
};

export const GATEWAY_APPLICATION = {
  title: "ragbot gateway",
  description:
    "Public surface of the ragbot gateway application. Generated applications use their own middleware clients and the gateway's non-public ApplicationMiddleware WorkerEntrypoint; service-to-service contracts remain Cap'n Proto.",
  version: "1.0.0",
  serverUrl: "https://ragbot.jsmunro.me",
} as const;

export const GATEWAY_SECURITY_SCHEMES = {
  controlToken: {
    type: "http",
    scheme: "bearer",
    description: "Gateway control-plane bearer token (GATEWAY_CONTROL_TOKEN secret).",
  },
} as const satisfies Record<GatewaySecurityScheme, unknown>;

export const GATEWAY_SCHEMAS = {
  GatewayControlResult: {
    type: "object",
    additionalProperties: true,
  },
} as const;

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

export const GATEWAY_ROUTE_BINDINGS = [
  {
    path: "/openapi.json",
    method: "GET",
    operationId: "openApiJson",
    summary: "Gateway generated OpenAPI document",
    responses: {
      "200": jsonObjectResponse("Generated OpenAPI document."),
    },
  },
  {
    path: "/.well-known/oauth-authorization-server",
    method: "GET",
    operationId: "oauthAuthorizationServerMetadata",
    summary: "Gateway OAuth authorization server discovery",
    responses: {
      "200": jsonObjectResponse("Discovery document."),
    },
  },
  {
    path: "/.well-known/openid-configuration",
    method: "GET",
    operationId: "openidConfiguration",
    summary: "Gateway OpenID Connect discovery",
    responses: {
      "200": jsonObjectResponse("Discovery document."),
    },
  },
  {
    path: "/.well-known/jwks.json",
    method: "GET",
    operationId: "jwks",
    summary: "Gateway JSON Web Key Set",
    description:
      "RFC 7517 JWK Set of the committed service-identity public keyring, for verifying " +
      "Ed25519 (EdDSA) signed identity-context tokens minted by ragbot workers.",
    responses: {
      "200": jsonObjectResponse("JWK Set document."),
    },
  },
  {
    path: "/gateway/start",
    method: "POST",
    operationId: "startGateway",
    summary: "Start the Discord gateway connection",
    security: "controlToken",
    responses: {
      "200": {
        description: "Gateway start result.",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/GatewayControlResult" },
          },
        },
      },
      "401": { description: "Missing or invalid control bearer token." },
      "403": { description: "Authenticated gateway-control application denied by policy." },
      "405": { description: "Method other than POST." },
    },
  },
  {
    path: "/gateway/stop",
    method: "POST",
    operationId: "stopGateway",
    summary: "Stop the Discord gateway connection",
    security: "controlToken",
    responses: {
      "200": {
        description: "Gateway stop result.",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/GatewayControlResult" },
          },
        },
      },
      "401": { description: "Missing or invalid control bearer token." },
      "403": { description: "Authenticated gateway-control application denied by policy." },
      "405": { description: "Method other than POST." },
    },
  },
  {
    path: "/gateway/health",
    method: "GET",
    operationId: "gatewayHealth",
    summary: "Discord gateway connection health",
    security: "controlToken",
    responses: {
      "200": {
        description: "Gateway health snapshot.",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/GatewayControlResult" },
          },
        },
      },
      "401": { description: "Missing or invalid control bearer token." },
      "403": { description: "Authenticated gateway-control application denied by policy." },
      "405": { description: "Method other than GET." },
    },
  },
] as const satisfies readonly GatewayRouteBinding[];
