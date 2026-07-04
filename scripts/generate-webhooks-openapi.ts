import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import {
  WEBHOOKS_APPLICATION,
  WEBHOOKS_COMPONENTS,
  WEBHOOKS_ROUTE_BINDINGS,
  type WebhooksRouteBinding,
} from "../workers/applications/webhooks/api/middleware_client/src/application-bindings";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const specPath = join(root, "workers/applications/webhooks/api/middleware_client/openapi.yaml");
const openApiModulePath = join(root, "workers/applications/webhooks/api/middleware_client/src/openapi.ts");

type Method = Lowercase<WebhooksRouteBinding["method"]>;

type OpenApiOperation = {
  operationId: string;
  summary: string;
  description?: string;
  security?: Array<Record<string, never[]>>;
  parameters?: unknown[];
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
  paths: Record<string, Partial<Record<Method, OpenApiOperation>>>;
  components: typeof WEBHOOKS_COMPONENTS;
};

const operationIds = new Set<string>();
const paths: OpenApi["paths"] = {};
const routeBindings: readonly WebhooksRouteBinding[] = WEBHOOKS_ROUTE_BINDINGS;

for (const binding of routeBindings) {
  if (operationIds.has(binding.operationId)) {
    throw new Error(`Duplicate webhooks operationId ${binding.operationId}`);
  }
  operationIds.add(binding.operationId);
  const operation: OpenApiOperation = {
    operationId: binding.operationId,
    summary: binding.summary,
    ...(binding.description ? { description: binding.description } : {}),
    ...(binding.security ? { security: binding.security } : {}),
    ...(binding.parameters ? { parameters: binding.parameters } : {}),
    ...(binding.requestBody ? { requestBody: binding.requestBody } : {}),
    responses: binding.responses,
  };
  (paths[binding.path] ??= {})[binding.method.toLowerCase() as Method] = operation;
}

const openapi: OpenApi = {
  openapi: "3.1.0",
  info: {
    title: WEBHOOKS_APPLICATION.title,
    description: WEBHOOKS_APPLICATION.description,
    version: WEBHOOKS_APPLICATION.version,
  },
  servers: [{ url: WEBHOOKS_APPLICATION.serverUrl }],
  paths,
  components: WEBHOOKS_COMPONENTS,
};

const openApiOutput = `// AUTO-GENERATED from webhooks application bindings by
// scripts/generate-webhooks-openapi.ts (\`npm run routes:build\`). Do not edit.

export const OPENAPI = ${JSON.stringify(openapi, null, 2)} as const;
`;

writeFileSync(specPath, YAML.stringify(openapi, { lineWidth: 100 }));
writeFileSync(openApiModulePath, openApiOutput);
process.stdout.write(`${specPath}\n${openApiModulePath}\n`);
