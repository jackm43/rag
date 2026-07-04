import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import {
  REGISTRY_APPLICATION,
  REGISTRY_ROUTE_BINDINGS,
  REGISTRY_SCHEMAS,
  REGISTRY_SECURITY_SCHEMES,
  type RegistryRouteBinding,
} from "../workers/applications/registry/api/middleware_client/src/application-bindings";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const specPath = join(root, "workers/applications/registry/api/middleware_client/openapi.yaml");
const openApiModulePath = join(root, "workers/applications/registry/api/middleware_client/src/openapi.ts");

type Method = "get" | "post" | "put" | "delete";
type OpenApiOperation = {
  operationId: string;
  summary: string;
  description?: string;
  security?: Array<Record<string, unknown[]>>;
  parameters?: readonly unknown[];
  requestBody?: unknown;
  responses: Record<string, unknown>;
};
type OpenApi = {
  openapi: "3.1.0";
  info: { title: string; description: string; version: string };
  servers: Array<{ url: string }>;
  paths: Record<string, Partial<Record<Method, OpenApiOperation>>>;
  components: {
    securitySchemes: typeof REGISTRY_SECURITY_SCHEMES;
    schemas: typeof REGISTRY_SCHEMAS;
  };
};

const securitySchemeNames = Object.keys(REGISTRY_SECURITY_SCHEMES);
const operationIds = new Set<string>();
const paths: OpenApi["paths"] = {};
const routeBindings: readonly RegistryRouteBinding[] = REGISTRY_ROUTE_BINDINGS;

for (const binding of routeBindings) {
  if (operationIds.has(binding.operationId)) {
    throw new Error(`Duplicate registry operationId ${binding.operationId}`);
  }
  operationIds.add(binding.operationId);
  for (const security of binding.security ?? []) {
    if (!securitySchemeNames.includes(security)) {
      throw new Error(`Unknown registry security scheme ${security} on ${binding.path}`);
    }
  }
  const operation: OpenApiOperation = {
    operationId: binding.operationId,
    summary: binding.summary,
    ...(binding.description ? { description: binding.description } : {}),
    ...(binding.security ? { security: [Object.fromEntries(binding.security.map((scheme) => [scheme, []]))] } : {}),
    ...(binding.parameters === undefined ? {} : { parameters: binding.parameters }),
    ...(binding.requestBody === undefined ? {} : { requestBody: binding.requestBody }),
    responses: binding.responses,
  };
  (paths[binding.path] ??= {})[binding.method.toLowerCase() as Method] = operation;
}

const openapi: OpenApi = {
  openapi: "3.1.0",
  info: {
    title: REGISTRY_APPLICATION.title,
    description: REGISTRY_APPLICATION.description,
    version: REGISTRY_APPLICATION.version,
  },
  servers: [{ url: REGISTRY_APPLICATION.serverUrl }],
  paths,
  components: {
    securitySchemes: REGISTRY_SECURITY_SCHEMES,
    schemas: REGISTRY_SCHEMAS,
  },
};

const openApiOutput = `// AUTO-GENERATED from registry application bindings by
// scripts/generate-registry-openapi.ts (\`npm run routes:build\`). Do not edit.

export const OPENAPI = ${JSON.stringify(openapi, null, 2)} as const;
`;

writeFileSync(specPath, YAML.stringify(openapi, { lineWidth: 100 }));
writeFileSync(openApiModulePath, openApiOutput);
process.stdout.write(`${specPath}\n${openApiModulePath}\n`);
