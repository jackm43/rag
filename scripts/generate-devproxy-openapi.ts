import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import {
  DEV_PROXY_APPLICATION,
  DEV_PROXY_ROUTE_BINDINGS,
  DEV_PROXY_SCHEMAS,
  DEV_PROXY_SECURITY_SCHEMES,
  type DevProxyMethod,
  type DevProxyRouteBinding,
} from "../workers/applications/dev-proxy/api/middleware_client/src/application-bindings";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const specPath = join(root, "workers/applications/dev-proxy/api/middleware_client/openapi.yaml");
const openApiModulePath = join(root, "workers/applications/dev-proxy/api/middleware_client/src/openapi.ts");

type Method = Lowercase<DevProxyMethod>;
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
    securitySchemes: typeof DEV_PROXY_SECURITY_SCHEMES;
    schemas: typeof DEV_PROXY_SCHEMAS;
  };
};

const securitySchemeNames = Object.keys(DEV_PROXY_SECURITY_SCHEMES);
const operationIds = new Set<string>();
const paths: OpenApi["paths"] = {};
const routeBindings: readonly DevProxyRouteBinding[] = DEV_PROXY_ROUTE_BINDINGS;

for (const binding of routeBindings) {
  if (operationIds.has(binding.operationId)) {
    throw new Error(`Duplicate dev-proxy operationId ${binding.operationId}`);
  }
  operationIds.add(binding.operationId);
  for (const security of binding.security ?? []) {
    if (!securitySchemeNames.includes(security)) {
      throw new Error(`Unknown dev-proxy security scheme ${security} on ${binding.path}`);
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
    title: DEV_PROXY_APPLICATION.title,
    description: DEV_PROXY_APPLICATION.description,
    version: DEV_PROXY_APPLICATION.version,
  },
  servers: [{ url: DEV_PROXY_APPLICATION.serverUrl }],
  paths,
  components: {
    securitySchemes: DEV_PROXY_SECURITY_SCHEMES,
    schemas: DEV_PROXY_SCHEMAS,
  },
};

const openApiOutput = `// AUTO-GENERATED from dev-proxy application bindings by
// scripts/generate-devproxy-openapi.ts (\`npm run routes:build\`). Do not edit.

export const OPENAPI = ${JSON.stringify(openapi, null, 2)} as const;
`;

writeFileSync(specPath, YAML.stringify(openapi, { lineWidth: 100 }));
writeFileSync(openApiModulePath, openApiOutput);
process.stdout.write(`${specPath}\n${openApiModulePath}\n`);
