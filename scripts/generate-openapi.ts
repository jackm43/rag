// Generates each application's OpenAPI document (openapi.yaml + the embedded
// src/openapi.ts module) from its application-bindings.ts. One script for
// every application edge worker — a new application only needs its bindings
// module; nothing here changes. The gateway is the one exception: its routes
// generator (generate-gateway-routes.ts) also emits routes.ts, so it keeps
// its own script.
//
// A bindings module contributes, by export-name suffix:
//   *_APPLICATION       — { title, description, version, serverUrl }
//   *_ROUTE_BINDINGS    — [{ path, method, operationId, summary, description?,
//                           security?, parameters?, requestBody?, responses }]
//   *_SECURITY_SCHEMES  — optional components.securitySchemes
//   *_SCHEMAS           — optional components.schemas
//   *_COMPONENTS        — optional full components object (wins over the two above)
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

type ApplicationMeta = { title: string; description: string; version: string; serverUrl: string };
type RouteBinding = {
  path: string;
  method: string;
  operationId: string;
  summary: string;
  description?: string;
  security?: unknown;
  parameters?: readonly unknown[];
  requestBody?: unknown;
  responses: Record<string, unknown>;
};

const findExport = (mod: Record<string, unknown>, suffix: string): unknown => {
  const keys = Object.keys(mod).filter((key) => key.endsWith(suffix));
  if (keys.length > 1) {
    throw new Error(`Multiple ${suffix} exports: ${keys.join(", ")}`);
  }
  return keys.length === 1 ? mod[keys[0]] : undefined;
};

// Accept the three security spellings the per-app generators used: a single
// scheme name, a list of scheme names, or a prebuilt requirement array.
const normaliseSecurity = (
  security: unknown,
  schemeNames: readonly string[],
  where: string,
): Array<Record<string, unknown[]>> | undefined => {
  if (security === undefined) {
    return undefined;
  }
  const names =
    typeof security === "string"
      ? [security]
      : Array.isArray(security) && security.every((entry) => typeof entry === "string")
        ? (security as string[])
        : null;
  if (names === null) {
    return security as Array<Record<string, unknown[]>>;
  }
  for (const name of names) {
    if (!schemeNames.includes(name)) {
      throw new Error(`Unknown security scheme ${name} on ${where}`);
    }
  }
  return [Object.fromEntries(names.map((name) => [name, []]))];
};

const generate = async (bindingsPath: string, workerDir: string): Promise<void> => {
  const mod = (await import(pathToFileURL(bindingsPath).href)) as Record<string, unknown>;
  const application = findExport(mod, "_APPLICATION") as ApplicationMeta | undefined;
  const routeBindings = findExport(mod, "_ROUTE_BINDINGS") as readonly RouteBinding[] | undefined;
  if (!application || !routeBindings) {
    return; // bindings module without an OpenAPI surface (e.g. gateway's)
  }
  const securitySchemes = findExport(mod, "_SECURITY_SCHEMES") as Record<string, unknown> | undefined;
  const schemas = findExport(mod, "_SCHEMAS") as Record<string, unknown> | undefined;
  const components =
    (findExport(mod, "_COMPONENTS") as Record<string, unknown> | undefined) ??
    (securitySchemes || schemas
      ? {
          ...(securitySchemes ? { securitySchemes } : {}),
          ...(schemas ? { schemas } : {}),
        }
      : undefined);
  const schemeNames = Object.keys(
    (components?.securitySchemes as Record<string, unknown> | undefined) ?? securitySchemes ?? {},
  );

  const operationIds = new Set<string>();
  const paths: Record<string, Record<string, unknown>> = {};
  for (const binding of routeBindings) {
    if (operationIds.has(binding.operationId)) {
      throw new Error(`Duplicate operationId ${binding.operationId} in ${bindingsPath}`);
    }
    operationIds.add(binding.operationId);
    const security = normaliseSecurity(binding.security, schemeNames, `${binding.method} ${binding.path}`);
    (paths[binding.path] ??= {})[binding.method.toLowerCase()] = {
      operationId: binding.operationId,
      summary: binding.summary,
      ...(binding.description ? { description: binding.description } : {}),
      ...(security ? { security } : {}),
      ...(binding.parameters === undefined ? {} : { parameters: binding.parameters }),
      ...(binding.requestBody === undefined ? {} : { requestBody: binding.requestBody }),
      responses: binding.responses,
    };
  }

  const openapi = {
    openapi: "3.1.0",
    info: {
      title: application.title,
      description: application.description,
      version: application.version,
    },
    servers: [{ url: application.serverUrl }],
    paths,
    ...(components ? { components } : {}),
  };

  const specPath = join(workerDir, "openapi.yaml");
  const openApiModulePath = join(workerDir, "src", "openapi.ts");
  const openApiOutput = `// AUTO-GENERATED from the application bindings by
// scripts/generate-openapi.ts (\`pnpm run routes:build\`). Do not edit.

export const OPENAPI = ${JSON.stringify(openapi, null, 2)} as const;
`;
  writeFileSync(specPath, YAML.stringify(openapi, { lineWidth: 100 }));
  writeFileSync(openApiModulePath, openApiOutput);
  process.stdout.write(`${specPath}\n${openApiModulePath}\n`);
};

for (const app of readdirSync(join(root, "apps"))) {
  const workersDir = join(root, "apps", app, "workers");
  if (!existsSync(workersDir)) {
    continue;
  }
  for (const worker of readdirSync(workersDir)) {
    if (app === "bot" && worker === "gateway") {
      continue; // generate-gateway-routes.ts owns the gateway's document
    }
    const workerDir = join(workersDir, worker, "api", "middleware_client");
    const bindingsPath = join(workerDir, "src", "application-bindings.ts");
    if (existsSync(bindingsPath)) {
      await generate(bindingsPath, workerDir);
    }
  }
}
