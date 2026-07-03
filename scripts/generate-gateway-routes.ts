import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

// Generates the gateway route table from openapi.yaml, following the same
// convention as the capnp contracts: the spec is the source of truth, the
// generated module is committed, and the router is constructed from it at
// runtime (`npm run routes:build` after editing the spec).

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const specPath = join(root, "workers/public/gateway/openapi.yaml");
const outPath = join(root, "workers/public/gateway/src/routes.ts");

type Operation = {
  operationId?: string;
  security?: Array<Record<string, unknown>>;
};

type Spec = {
  paths?: Record<string, Record<string, Operation>>;
  components?: { securitySchemes?: Record<string, unknown> };
};

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

const spec = parse(readFileSync(specPath, "utf8")) as Spec;
const schemeNames = Object.keys(spec.components?.securitySchemes ?? {}).sort();
if (schemeNames.length === 0) {
  throw new Error("openapi.yaml declares no securitySchemes");
}

type Route = { method: string; operationId: string; security: string | null };
const routes: Record<string, Route[]> = {};

for (const [path, operations] of Object.entries(spec.paths ?? {})) {
  for (const [method, operation] of Object.entries(operations)) {
    if (!HTTP_METHODS.includes(method)) {
      continue;
    }
    if (!operation.operationId) {
      throw new Error(`Missing operationId for ${method.toUpperCase()} ${path}`);
    }
    const security = operation.security?.[0] ? Object.keys(operation.security[0])[0] : null;
    if (security !== null && !schemeNames.includes(security)) {
      throw new Error(`Unknown security scheme "${security}" on ${method.toUpperCase()} ${path}`);
    }
    (routes[path] ??= []).push({
      method: method.toUpperCase(),
      operationId: operation.operationId,
      security,
    });
  }
}

if (Object.keys(routes).length === 0) {
  throw new Error("openapi.yaml declares no paths");
}

const routeLiteral = (route: Route) =>
  `{ method: ${JSON.stringify(route.method)}, operationId: ${JSON.stringify(route.operationId)}, security: ${
    route.security === null ? "null" : JSON.stringify(route.security)
  } }`;

const entries = Object.entries(routes)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(
    ([path, pathRoutes]) =>
      `  ${JSON.stringify(path)}: [\n${pathRoutes.map((route) => `    ${routeLiteral(route)},`).join("\n")}\n  ],`,
  )
  .join("\n");

const output = `// AUTO-GENERATED from workers/public/gateway/openapi.yaml by
// scripts/generate-gateway-routes.ts (\`npm run routes:build\`). Do not edit.

export type GatewaySecurityScheme = ${schemeNames.map((name) => JSON.stringify(name)).join(" | ")};

export type GatewayRoute = {
  method: string;
  operationId: string;
  security: GatewaySecurityScheme | null;
};

export const GATEWAY_ROUTES: Record<string, readonly GatewayRoute[]> = {
${entries}
};
`;

writeFileSync(outPath, output);
process.stdout.write(`${outPath}\n`);
