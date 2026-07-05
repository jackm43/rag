import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import {
  GATEWAY_APPLICATION,
  GATEWAY_ROUTE_BINDINGS,
  GATEWAY_SCHEMAS,
  GATEWAY_SECURITY_SCHEMES,
  type GatewayRouteBinding,
} from "@rag/gateway/api/middleware_client/src/application-bindings";

// Generates the gateway OpenAPI document and route table from application
// bindings. This keeps the gateway aligned with generated application
// middleware clients: bindings are the source of truth; OpenAPI and router data
// are build artifacts (`pnpm run routes:build` after editing bindings).

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const specPath = join(root, "apps/bot/workers/gateway/api/middleware_client/openapi.yaml");
const openApiModulePath = join(root, "apps/bot/workers/gateway/api/middleware_client/src/openapi.ts");
const routesPath = join(root, "apps/bot/workers/gateway/api/middleware_client/src/routes.ts");

const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD", "PATCH", "TRACE"] as const;
type HttpMethod = typeof HTTP_METHODS[number];

type OpenApiOperation = {
  operationId: string;
  summary: string;
  description?: string;
  security?: Array<Record<string, unknown[]>>;
  requestBody?: unknown;
  responses: Record<string, unknown>;
};

type OpenApi = {
  openapi: "3.1.0";
  info: {
    title: string;
    description: string;
    version: string;
  };
  servers: Array<{ url: string }>;
  paths: Record<string, Partial<Record<Lowercase<HttpMethod>, OpenApiOperation>>>;
  components: {
    securitySchemes: typeof GATEWAY_SECURITY_SCHEMES;
    schemas: typeof GATEWAY_SCHEMAS;
  };
};

const methodKey = (method: HttpMethod): Lowercase<HttpMethod> =>
  method.toLowerCase() as Lowercase<HttpMethod>;

const securitySchemeNames = Object.keys(GATEWAY_SECURITY_SCHEMES).sort();
const operationIds = new Set<string>();
const paths: OpenApi["paths"] = {};
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

  const operation: OpenApiOperation = {
    operationId: binding.operationId,
    summary: binding.summary,
    ...(binding.description ? { description: binding.description } : {}),
    ...(binding.security ? { security: [{ [binding.security]: [] }] } : {}),
    ...(binding.requestBody === undefined ? {} : { requestBody: binding.requestBody }),
    responses: binding.responses,
  };
  (paths[binding.path] ??= {})[methodKey(binding.method)] = operation;
}

if (Object.keys(paths).length === 0) {
  throw new Error("Gateway application bindings declare no routes");
}

const openapi: OpenApi = {
  openapi: "3.1.0",
  info: {
    title: GATEWAY_APPLICATION.title,
    description: GATEWAY_APPLICATION.description,
    version: GATEWAY_APPLICATION.version,
  },
  servers: [{ url: GATEWAY_APPLICATION.serverUrl }],
  paths,
  components: {
    securitySchemes: GATEWAY_SECURITY_SCHEMES,
    schemas: GATEWAY_SCHEMAS,
  },
};

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

const openApiOutput = `// AUTO-GENERATED from gateway application bindings by
// scripts/generate-gateway-routes.ts (\`pnpm run routes:build\`). Do not edit.

export const OPENAPI = ${JSON.stringify(openapi, null, 2)} as const;
`;

writeFileSync(specPath, YAML.stringify(openapi, { lineWidth: 100 }));
writeFileSync(openApiModulePath, openApiOutput);
writeFileSync(routesPath, routesOutput);
process.stdout.write(`${specPath}\n${openApiModulePath}\n${routesPath}\n`);
