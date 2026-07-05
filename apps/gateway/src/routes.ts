// AUTO-GENERATED from gateway application bindings by
// scripts/generate-gateway-routes.ts (`pnpm run routes:build`). Do not edit.

export type GatewaySecurityScheme = "controlToken";

export type GatewayRoute = {
  method: string;
  operationId: string;
  security: GatewaySecurityScheme | null;
};

export const GATEWAY_ROUTES: Record<string, readonly GatewayRoute[]> = {
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
