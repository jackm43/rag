import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GATEWAY_ROUTE_BINDINGS,
  GATEWAY_SECURITY_SCHEMES,
  type GatewayRouteBinding,
} from "@rag/gateway/src/application-bindings";

// Generates the gateway's router table from application bindings. The gateway is
// operator-only (bearer-token control routes) with no public discovery surface,
// so there is no OpenAPI document — bindings are the source of truth and
// routes.ts is the sole build artifact (`pnpm run routes:build` after editing
// bindings).

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const routesPath = join(root, "apps/gateway/src/routes.ts");

const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH", "TRACE"] as const;

const securitySchemeNames: readonly string[] = GATEWAY_SECURITY_SCHEMES;
const operationIds = new Set<string>();
const routeBindings: readonly GatewayRouteBinding[] = GATEWAY_ROUTE_BINDINGS;

for (const binding of routeBindings) {
  if (!HTTP_METHODS.includes(binding.method)) {
    throw new Error(`Unsupported gateway method ${binding.method} on ${binding.path}`);
  }
  if (operationIds.has(binding.operationId)) {
    throw new Error(`Duplicate gateway operationId ${binding.operationId}`);
  }
  operationIds.add(binding.operationId);
  if (binding.security && !securitySchemeNames.includes(binding.security)) {
    throw new Error(`Unknown gateway security scheme ${binding.security} on ${binding.path}`);
  }
}

if (routeBindings.length === 0) {
  throw new Error("Gateway application bindings declare no routes");
}

const sortedRouteBindings = [...routeBindings].sort((left, right) =>
  left.path === right.path
    ? left.method.localeCompare(right.method)
    : left.path.localeCompare(right.path)
);

const routeLiteral = (route: GatewayRouteBinding) =>
  `{ method: ${JSON.stringify(route.method)}, operationId: ${JSON.stringify(route.operationId)}, security: ${
    route.security === undefined ? "null" : JSON.stringify(route.security)
  } }`;

const routesByPath = new Map<string, GatewayRouteBinding[]>();
for (const route of sortedRouteBindings) {
  routesByPath.set(route.path, [...(routesByPath.get(route.path) ?? []), route]);
}

const routeEntries = [...routesByPath.entries()]
  .map(
    ([path, routes]) =>
      `  ${JSON.stringify(path)}: [\n${routes.map((route) => `    ${routeLiteral(route)},`).join("\n")}\n  ],`,
  )
  .join("\n");

const securityType = securitySchemeNames.map((name) => JSON.stringify(name)).join(" | ");

const routesOutput = `// AUTO-GENERATED from gateway application bindings by
// scripts/generate-gateway-routes.ts (\`pnpm run routes:build\`). Do not edit.

export type GatewaySecurityScheme = ${securityType};

export type GatewayRoute = {
  method: string;
  operationId: string;
  security: GatewaySecurityScheme | null;
};

export const GATEWAY_ROUTES: Record<string, readonly GatewayRoute[]> = {
${routeEntries}
};
`;

writeFileSync(routesPath, routesOutput);
process.stdout.write(`${routesPath}\n`);
