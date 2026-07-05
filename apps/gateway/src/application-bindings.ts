export type GatewaySecurityScheme = "controlToken";

export type GatewayRouteBinding = {
  path: string;
  method: "GET" | "POST";
  operationId: string;
  security?: GatewaySecurityScheme;
};

// The gateway's HTTP surface is operator-only: three control routes, each gated
// by the GATEWAY_CONTROL_TOKEN bearer. There is no public discovery surface
// (no /openapi.json, no /.well-known/*) — nothing here is a third-party API, and
// per-worker signing keys were removed, so the former key-set/OIDC stubs served
// nothing. `pnpm run routes:build` regenerates routes.ts from these bindings.
export const GATEWAY_SECURITY_SCHEMES = ["controlToken"] as const;

export const GATEWAY_ROUTE_BINDINGS = [
  {
    path: "/gateway/start",
    method: "POST",
    operationId: "startGateway",
    security: "controlToken",
  },
  {
    path: "/gateway/stop",
    method: "POST",
    operationId: "stopGateway",
    security: "controlToken",
  },
  {
    path: "/gateway/health",
    method: "GET",
    operationId: "gatewayHealth",
    security: "controlToken",
  },
] as const satisfies readonly GatewayRouteBinding[];
