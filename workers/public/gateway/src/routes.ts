// AUTO-GENERATED from workers/public/gateway/openapi.yaml by
// scripts/generate-gateway-routes.ts (`npm run routes:build`). Do not edit.

export type GatewaySecurityScheme = "controlToken" | "discordSignature";

export type GatewayRoute = {
  method: string;
  operationId: string;
  security: GatewaySecurityScheme | null;
};

export const GATEWAY_ROUTES: Record<string, readonly GatewayRoute[]> = {
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
};
