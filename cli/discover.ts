import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import process from "node:process";

// Discovery: read the dev-proxy's committed OpenAPI spec and enumerate its
// operations. Reading the committed file (rather than fetching from the server)
// keeps discovery working offline and in lockstep with the typed client, which
// is generated from the same spec. $RAGCTL_OPENAPI overrides the path.

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

export type DiscoveredOperation = {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  security: string[];
};

type SpecOperation = {
  operationId?: string;
  summary?: string;
  security?: Array<Record<string, unknown>>;
};

type Spec = {
  servers?: Array<{ url?: string }>;
  paths?: Record<string, Record<string, SpecOperation>>;
};

// The spec lives at apps/connectors/workers/dev-proxy/api/middleware_client/openapi.yaml, one level up from cli/.
const defaultSpecPath = (): string =>
  join(dirname(fileURLToPath(import.meta.url)), "..", "workers", "applications", "dev-proxy", "api", "middleware_client", "openapi.yaml");

export const specPath = (): string => process.env.RAGCTL_OPENAPI ?? defaultSpecPath();

const loadSpec = (): Spec => {
  const path = specPath();
  if (!existsSync(path)) {
    throw new Error(`OpenAPI spec not found at ${path} (set RAGCTL_OPENAPI to override)`);
  }
  return parse(readFileSync(path, "utf8")) as Spec;
};

export type Discovery = {
  serverUrl?: string;
  operations: DiscoveredOperation[];
};

export const discover = (): Discovery => {
  const spec = loadSpec();
  const operations: DiscoveredOperation[] = [];
  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = methods[method];
      if (!operation) {
        continue;
      }
      const security = (operation.security ?? []).flatMap((requirement) => Object.keys(requirement));
      operations.push({
        method: method.toUpperCase(),
        path,
        operationId: operation.operationId,
        summary: operation.summary,
        security,
      });
    }
  }
  return { serverUrl: spec.servers?.[0]?.url, operations };
};
