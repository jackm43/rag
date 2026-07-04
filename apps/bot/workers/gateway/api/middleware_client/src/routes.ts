// AUTO-GENERATED from gateway application bindings by
// scripts/generate-gateway-routes.ts (`pnpm run routes:build`). Do not edit.

export type GatewaySecurityScheme = "controlToken" | "discordSignature";

export type GatewayRoute = {
  method: string;
  operationId: string;
  security: GatewaySecurityScheme | null;
};

export const GATEWAY_ROUTES: Record<string, readonly GatewayRoute[]> = {
  "/.well-known/jwks.json": [
    { method: "GET", operationId: "jwks", security: null },
  ],
  "/.well-known/oauth-authorization-server": [
    { method: "GET", operationId: "oauthAuthorizationServerMetadata", security: null },
  ],
  "/.well-known/openid-configuration": [
    { method: "GET", operationId: "openidConfiguration", security: null },
  ],
  "/discord": [
    { method: "POST", operationId: "discordInteraction", security: "discordSignature" },
  ],
  "/gateway/health": [
    { method: "GET", operationId: "gatewayHealth", security: "controlToken" },
  ],
  "/gateway/start": [
    { method: "POST", operationId: "startGateway", security: "controlToken" },
  ],
  "/gateway/stop": [
    { method: "POST", operationId: "stopGateway", security: "controlToken" },
  ],
  "/openapi.json": [
    { method: "GET", operationId: "openApiJson", security: null },
  ],
};
