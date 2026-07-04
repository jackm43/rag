import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import {
  ATTEST_APPLICATION,
  ATTEST_ROUTE_BINDINGS,
  type AttestRouteBinding,
} from "../workers/applications/attest/api/middleware_client/src/application-bindings";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const specPath = join(root, "workers/applications/attest/api/middleware_client/openapi.yaml");
const openApiModulePath = join(root, "workers/applications/attest/api/middleware_client/src/openapi.ts");

type OpenApiOperation = {
  operationId: string;
  summary: string;
  description?: string;
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
};

const routeBindings: readonly AttestRouteBinding[] = ATTEST_ROUTE_BINDINGS;
const operationIds = new Set<string>();
const paths: OpenApi["paths"] = {};

for (const binding of routeBindings) {
  if (operationIds.has(binding.operationId)) {
    throw new Error(`Duplicate attest operationId ${binding.operationId}`);
  }
  operationIds.add(binding.operationId);
  const operation: OpenApiOperation = {
    operationId: binding.operationId,
    summary: binding.summary,
    ...(binding.description ? { description: binding.description } : {}),
    responses: binding.responses,
  };
  (paths[binding.path] ??= {})[binding.method.toLowerCase() as "get" | "post"] = operation;
}

const openapi: OpenApi = {
  openapi: "3.1.0",
  info: {
    title: ATTEST_APPLICATION.title,
    description: ATTEST_APPLICATION.description,
    version: ATTEST_APPLICATION.version,
  },
  servers: [{ url: ATTEST_APPLICATION.serverUrl }],
  paths,
};

const openApiOutput = `// AUTO-GENERATED from attest application bindings by
// scripts/generate-attest-openapi.ts (\`npm run routes:build\`). Do not edit.

export const OPENAPI = ${JSON.stringify(openapi, null, 2)} as const;
`;

writeFileSync(specPath, YAML.stringify(openapi, { lineWidth: 100 }));
writeFileSync(openApiModulePath, openApiOutput);
process.stdout.write(`${specPath}\n${openApiModulePath}\n`);
