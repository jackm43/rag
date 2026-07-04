import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import {
  METADATA_APPLICATION,
  METADATA_ROUTE_BINDINGS,
  METADATA_SECURITY_SCHEMES,
  type MetadataRouteBinding,
} from "../workers/applications/metadata/api/middleware_client/src/application-bindings";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const specPath = join(root, "workers/applications/metadata/api/middleware_client/openapi.yaml");
const openApiModulePath = join(root, "workers/applications/metadata/api/middleware_client/src/openapi.ts");

type OpenApiOperation = {
  operationId: string;
  summary: string;
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
  paths: Record<string, Partial<Record<"get" | "post", OpenApiOperation>>>;
  components: {
    securitySchemes: typeof METADATA_SECURITY_SCHEMES;
  };
};

const routeBindings: readonly MetadataRouteBinding[] = METADATA_ROUTE_BINDINGS;
const securitySchemeNames = Object.keys(METADATA_SECURITY_SCHEMES);
const operationIds = new Set<string>();
const paths: OpenApi["paths"] = {};

for (const binding of routeBindings) {
  if (operationIds.has(binding.operationId)) {
    throw new Error(`Duplicate metadata operationId ${binding.operationId}`);
  }
  operationIds.add(binding.operationId);
  if (binding.security && !securitySchemeNames.includes(binding.security)) {
    throw new Error(`Unknown metadata security scheme ${binding.security} on ${binding.path}`);
  }
  const operation: OpenApiOperation = {
    operationId: binding.operationId,
    summary: binding.summary,
    ...(binding.security ? { security: [{ [binding.security]: [] }] } : {}),
    ...(binding.requestBody === undefined ? {} : { requestBody: binding.requestBody }),
    responses: binding.responses,
  };
  (paths[binding.path] ??= {})[binding.method.toLowerCase() as "get" | "post"] = operation;
}

const openapi: OpenApi = {
  openapi: "3.1.0",
  info: {
    title: METADATA_APPLICATION.title,
    description: METADATA_APPLICATION.description,
    version: METADATA_APPLICATION.version,
  },
  servers: [{ url: METADATA_APPLICATION.serverUrl }],
  paths,
  components: {
    securitySchemes: METADATA_SECURITY_SCHEMES,
  },
};

const openApiOutput = `// AUTO-GENERATED from metadata application bindings by
// scripts/generate-metadata-openapi.ts (\`npm run routes:build\`). Do not edit.

export const OPENAPI = ${JSON.stringify(openapi, null, 2)} as const;
`;

writeFileSync(specPath, YAML.stringify(openapi, { lineWidth: 100 }));
writeFileSync(openApiModulePath, openApiOutput);
process.stdout.write(`${specPath}\n${openApiModulePath}\n`);
