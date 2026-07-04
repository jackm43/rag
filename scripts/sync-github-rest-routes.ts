import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const SPEC_URL =
  "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.yaml";
const METHODS = new Set(["get", "post", "put", "patch", "delete"]);

type OpenApiOperation = {
  operationId?: unknown;
  summary?: unknown;
  tags?: unknown;
  parameters?: unknown;
};

type RouteEntry = {
  key: string;
  method: string;
  path: string;
  label: string;
  tag: string;
  route: string;
  params: Record<string, string | number | boolean>;
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = join(root, "dist", "github-rest-routes.json");

const field = (record: unknown, name: string): unknown =>
  record && typeof record === "object" && !Array.isArray(record) ? (record as Record<string, unknown>)[name] : undefined;

const resolveRef = (spec: { components?: { parameters?: Record<string, unknown> } }, value: unknown): unknown => {
  const ref = field(value, "$ref");
  if (typeof ref !== "string" || !ref.startsWith("#/components/parameters/")) {
    return value;
  }
  return spec.components?.parameters?.[ref.slice("#/components/parameters/".length)] ?? value;
};

const sampleValue = (name: string, location: string): string | number | boolean => {
  if (location === "path") {
    if (name === "owner" || name === "org" || name === "username" || name === "enterprise") return "jsmunro";
    if (name === "repo") return "rag";
    if (name === "path") return "README.md";
    return "";
  }
  if (name === "per_page") return 10;
  if (name === "page") return 1;
  if (name === "state") return "open";
  return "";
};

const response = await fetch(SPEC_URL, {
  headers: { "user-agent": "ragbot-devproxy-route-sync" },
});
if (!response.ok) {
  throw new Error(`GitHub OpenAPI download failed: HTTP ${response.status}`);
}

const spec = YAML.parse(await response.text()) as {
  paths?: Record<string, Record<string, unknown>>;
  components?: { parameters?: Record<string, unknown> };
};
const routes: RouteEntry[] = [];
for (const [path, item] of Object.entries(spec.paths ?? {})) {
  const pathParameters = Array.isArray(item.parameters) ? item.parameters : [];
  for (const [rawMethod, rawOperation] of Object.entries(item)) {
    if (!METHODS.has(rawMethod) || !rawOperation || typeof rawOperation !== "object" || Array.isArray(rawOperation)) {
      continue;
    }
    const operation = rawOperation as OpenApiOperation;
    const method = rawMethod.toUpperCase();
    const tags = Array.isArray(operation.tags) ? operation.tags : [];
    const tag = typeof tags[0] === "string" ? tags[0] : "GitHub";
    const params: Record<string, string | number | boolean> = {};
    const parameters = [...pathParameters, ...(Array.isArray(operation.parameters) ? operation.parameters : [])];
    for (const parameter of parameters) {
      const resolved = resolveRef(spec, parameter);
      const name = field(resolved, "name");
      const location = field(resolved, "in");
      if (typeof name !== "string" || typeof location !== "string" || (location !== "path" && location !== "query")) {
        continue;
      }
      const value = sampleValue(name, location);
      if (location === "path" || value !== "") {
        params[name] = value;
      }
    }
    routes.push({
      key: `${method} ${path}`,
      method,
      path,
      route: `${method} ${path}`,
      label: typeof operation.summary === "string" ? operation.summary : `${method} ${path}`,
      tag,
      params,
    });
  }
}

routes.sort((left, right) => `${left.tag} ${left.path} ${left.method}`.localeCompare(`${right.tag} ${right.path} ${right.method}`));
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  JSON.stringify(
    {
      source: SPEC_URL,
      generatedAt: new Date().toISOString(),
      count: routes.length,
      routes,
    },
    null,
    2,
  ),
);
console.log(`Wrote ${routes.length} GitHub REST routes to ${outPath}`);
