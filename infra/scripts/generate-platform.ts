import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const resourcesPath = join(root, "infra/applications/resources.yaml");
const applicationsPath = join(root, "infra/applications/applications.yaml");

type RawMethod = {
  name: string;
  scope: string;
  http: {
    method: string;
    path: string;
    pathParams?: string[];
    stream?: string;
  };
};

type RawResource = {
  name: string;
  methods: RawMethod[];
};

type RawCatalog = {
  applications: Record<string, { resources: RawResource[] }>;
};

type RawApplications = {
  applications: Record<string, {
    description?: string;
    endpoint?: string;
    config?: string;
    delegations?: Array<{ audience: string; scopes?: string[] }>;
    browser_auth_client?: boolean;
    service_client?: boolean;
    provider_auth?: string;
  }>;
};

const operationIdForMethod = (name: string): string =>
  name.charAt(0).toLowerCase() + name.slice(1);

const apiNameFromPath = (path: string): string => {
  const match = /^\/platform\/([^/]+)\/v\d+\//.exec(path);
  if (!match) {
    throw new Error(`cannot derive api name from path ${path}`);
  }
  return match[1];
};

const proxyPrefixesForApplication = (entry: { resources: RawResource[] } | undefined): string[] => {
  if (!entry) {
    return [];
  }
  const prefixes = new Set<string>();
  for (const resource of entry.resources) {
    for (const method of resource.methods) {
      const match = /^(\/platform\/[^/]+\/v\d+\/)/.exec(method.http.path);
      if (match) {
        prefixes.add(match[1]);
      }
    }
  }
  return [...prefixes].sort();
};

const identityContextForMethod = (resourceName: string): "dpop" | "none" =>
  resourceName === "RegistryService" ? "none" : "dpop";

const buildCatalog = (raw: RawCatalog) => {
  const applications: Record<string, unknown> = {};
  for (const [application, entry] of Object.entries(raw.applications)) {
    const samplePath = entry.resources[0]?.methods[0]?.http.path;
    if (!samplePath) {
      continue;
    }
    const apiName = apiNameFromPath(samplePath);
    const routePrefix = `/platform/${apiName}/v1/`;
    applications[application] = {
      audience: application,
      apiName,
      routePrefix,
      resources: entry.resources.map((resource) => ({
        name: resource.name,
        methods: resource.methods.map((method) => ({
          name: method.name,
          scope: method.scope,
          operationId: operationIdForMethod(method.name),
          http: {
            method: method.http.method,
            path: method.http.path,
            ...(method.http.pathParams ? { pathParams: method.http.pathParams } : {}),
            ...(method.http.stream ? { stream: method.http.stream } : {}),
          },
          route: {
            namespace: "platform",
            apiName,
            version: "v1",
            audience: application,
            method: method.http.method,
            path: method.http.path,
            operationId: operationIdForMethod(method.name),
            summary: `${resource.name}.${method.name}`,
            auth: "gateway-jwt",
            identityContext: identityContextForMethod(resource.name),
            scopes: [method.scope],
            tags: [resource.name.replace(/Service$/, "").toLowerCase()],
          },
        })),
      })),
    };
  }
  return { applications };
};

const writeCatalog = (catalog: ReturnType<typeof buildCatalog>) => {
  const outPath = join(root, "infra/sdk/ts/src/catalog/data.generated.ts");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    `import type { PlatformCatalog } from "./types";

export const PLATFORM_CATALOG = ${JSON.stringify(catalog, null, 2)} as unknown as PlatformCatalog;
`,
  );
};

const idpRegisterScope = "idp/ClientIdentityService.RegisterClientIdentity";

const workerServiceName = (audience: string): string =>
  audience === "ragbot" ? "ragbot-worker" : audience === "idp" ? "auth-gateway" : audience;

const targetBinding = (audience: string): string =>
  audience === "idp" ? "AUTH_GATEWAY" : audience.toUpperCase();

const targetEndpointVar = (audience: string): string =>
  audience === "idp" ? "AUTH_GATEWAY_URL" : `${audience.toUpperCase()}_ENDPOINT`;

type ProxyTargetSpec = {
  audience: string;
  binding: string;
  endpoint: string;
  scopes?: string[];
  prefixes: string[];
};

const proxyTargetsForApp = (
  delegations: Array<{ audience: string; scopes?: string[] }>,
  catalog: RawCatalog,
): ProxyTargetSpec[] => {
  const targets: ProxyTargetSpec[] = [];
  for (const delegation of delegations) {
    targets.push({
      audience: delegation.audience,
      binding: targetBinding(delegation.audience),
      endpoint: targetEndpointVar(delegation.audience),
      scopes: delegation.scopes,
      prefixes: proxyPrefixesForApplication(catalog.applications[delegation.audience]),
    });
  }
  return targets;
};

const runWorkerFirstRoutes = (targets: ProxyTargetSpec[]): string[] => {
  const routes = new Set<string>(["/client/*"]);
  for (const target of targets) {
    for (const prefix of target.prefixes) {
      routes.add(`${prefix}*`);
    }
  }
  return [...routes].sort();
};

const bffWorkerSource = (app: string, targets: ProxyTargetSpec[], registerIdentity: boolean) => {
  const targetBlocks = targets.map((target) => {
    const lines = [
      "    {",
      `      audience: ${JSON.stringify(target.audience)},`,
      `      binding: ${JSON.stringify(target.binding)},`,
      `      endpoint: ${JSON.stringify(target.endpoint)},`,
      "      prefixes: [",
      ...target.prefixes.map((prefix) => `        ${JSON.stringify(prefix)},`),
      "      ],",
    ];
    if (target.scopes?.length) {
      lines.push("      scopes: [");
      for (const scope of target.scopes) {
        lines.push(`        ${JSON.stringify(scope)},`);
      }
      lines.push("      ],");
    }
    lines.push("    },");
    return lines.join("\n");
  }).join("\n");

  return `${registerIdentity ? 'import { idp } from "../../../idp/service";\n' : ""}import { createWebBffWorker } from "@platy/sdk";

export default createWebBffWorker({
  app: ${JSON.stringify(app)},
${registerIdentity ? "  registerClient: idp.clientIdentityServiceClient,\n" : ""}  targets: [
${targetBlocks}
  ],
});
`;
};

const needsGatewayBinding = (entry: RawApplications["applications"][string]): boolean =>
  Boolean(
    entry.service_client
    || entry.browser_auth_client
    || entry.delegations?.some((delegation) => delegation.audience === "idp"),
  );

const collectServiceBindings = (
  app: string,
  entry: RawApplications["applications"][string],
): Array<{ binding: string; service: string }> => {
  if (app === "idp") {
    return [];
  }
  const bindings = new Map<string, string>();
  const addBinding = (audience: string) => {
    bindings.set(targetBinding(audience), workerServiceName(audience));
  };
  if (needsGatewayBinding(entry)) {
    addBinding("idp");
  }
  for (const delegation of entry.delegations ?? []) {
    addBinding(delegation.audience);
  }
  return [...bindings.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([binding, service]) => ({ binding, service }));
};

const collectTransportVars = (
  app: string,
  entry: RawApplications["applications"][string],
  manifest: RawApplications,
): Record<string, string> => {
  const vars: Record<string, string> = {
    OTEL_SERVICE_NAME: app === "idp" ? "auth-gateway" : app,
    PLATY_APPLICATION: app,
  };
  if (app === "idp") {
    return vars;
  }
  const gatewayEndpoint = manifest.applications.idp?.endpoint;
  if (needsGatewayBinding(entry) && gatewayEndpoint) {
    vars.AUTH_GATEWAY_URL = gatewayEndpoint;
  }
  for (const delegation of entry.delegations ?? []) {
    const endpointVar = targetEndpointVar(delegation.audience);
    const targetEndpoint = manifest.applications[delegation.audience]?.endpoint;
    if (targetEndpoint) {
      vars[endpointVar] = targetEndpoint;
    }
  }
  return vars;
};

const patchWranglerServices = (
  wranglerPath: string,
  services: Array<{ binding: string; service: string }>,
) => {
  let source = readFileSync(wranglerPath, "utf8");
  if (services.length === 0) {
    if (!/"services"\s*:\s*\[/s.test(source)) {
      return;
    }
    const next = source.replace(/,?\n?\s*"services"\s*:\s*\[[^\]]*\]/s, "");
    if (next === source) {
      return;
    }
    writeFileSync(wranglerPath, next);
    return;
  }
  const formatted = services.map((service) =>
    `    {\n      "binding": ${JSON.stringify(service.binding)},\n      "service": ${JSON.stringify(service.service)}\n    }`,
  ).join(",\n");
  const block = `"services": [\n${formatted}\n  ]`;
  if (/"services"\s*:\s*\[/s.test(source)) {
    source = source.replace(/"services"\s*:\s*\[[^\]]*\]/s, block);
  } else {
    source = source.replace(/"observability"\s*:/, `${block},\n  "observability":`);
  }
  writeFileSync(wranglerPath, source);
};

const patchWranglerVars = (wranglerPath: string, vars: Record<string, string>) => {
  if (Object.keys(vars).length === 0) {
    return;
  }
  let source = readFileSync(wranglerPath, "utf8");
  if (!/"vars"\s*:\s*\{/s.test(source)) {
    source = source.replace(
      /"routes"\s*:\s*\[[^\]]*\]/s,
      (match) => `${match},\n  "vars": {}`,
    );
  }
  for (const [key, value] of Object.entries(vars)) {
    const pattern = new RegExp(`"${key}"\\s*:\\s*"[^"]*"`);
    if (pattern.test(source)) {
      source = source.replace(pattern, `"${key}": ${JSON.stringify(value)}`);
      continue;
    }
    source = source.replace(
      /"vars"\s*:\s*\{/,
      `"vars": {\n    "${key}": ${JSON.stringify(value)},`,
    );
  }
  writeFileSync(wranglerPath, source);
};

const writeWranglerBindings = (manifest: RawApplications) => {
  for (const [app, entry] of Object.entries(manifest.applications)) {
    if (!entry.config) {
      continue;
    }
    const wranglerPath = join(root, entry.config);
    const services = collectServiceBindings(app, entry);
    const vars = collectTransportVars(app, entry, manifest);
    patchWranglerServices(wranglerPath, services);
    patchWranglerVars(wranglerPath, vars);
  }
};

const patchWranglerProxyRoutes = (wranglerPath: string, routes: string[]) => {
  const source = readFileSync(wranglerPath, "utf8");
  if (!/"run_worker_first"\s*:/s.test(source)) {
    return;
  }
  const formatted = routes.map((route) => `      ${JSON.stringify(route)}`).join(",\n");
  const next = source.replace(
    /"run_worker_first"\s*:\s*\[[^\]]*\]/s,
    `"run_worker_first": [\n${formatted}\n    ]`,
  );
  if (next === source) {
    return;
  }
  writeFileSync(wranglerPath, next);
};

const writeBffWorkers = (manifest: RawApplications, catalog: RawCatalog) => {
  for (const [app, entry] of Object.entries(manifest.applications)) {
    if (!entry.config || !entry.delegations?.length || !entry.browser_auth_client) {
      continue;
    }
    const workerDir = dirname(join(root, entry.config));
    const workerPath = join(workerDir, "src/worker.ts");
    const wranglerPath = join(root, entry.config);
    const targets = proxyTargetsForApp(entry.delegations, catalog);
    const registerIdentity = entry.delegations.some((delegation) =>
      delegation.audience === "idp" && (delegation.scopes ?? []).includes(idpRegisterScope),
    );
    writeFileSync(workerPath, bffWorkerSource(app, targets, registerIdentity));
    patchWranglerProxyRoutes(wranglerPath, runWorkerFirstRoutes(targets));
  }
};

const serviceClientSource = (application: string, resources: RawResource[]) => {
  const clients = resources.map((resource) => {
    const key = `${resource.name.charAt(0).toLowerCase()}${resource.name.slice(1)}Client`;
    return `  ${key}: (connection: Connection, identity: Identity) =>
    createPlatformServiceClient(APPLICATION, connection, identity).${key}(),`;
  }).join("\n");
  return `import {
  createPlatformServiceClient,
  type ConnectorConfig,
  type Identity,
} from "@platy/sdk";

export const APPLICATION = ${JSON.stringify(application)};
export type Connection = Omit<ConnectorConfig, "application">;

export const ${application} = {
${clients}
};
`;
};

const serviceClientApps = new Set(["idp", "aigateway", "ragbot", "deploy"]);

const writeServiceClients = (manifest: RawApplications, resources: RawCatalog) => {
  for (const [app, entry] of Object.entries(manifest.applications)) {
    const appResources = resources.applications[app]?.resources ?? [];
    if (entry.service_client && appResources.length > 0 && serviceClientApps.has(app)) {
      const dir = join(root, "infra/applications", app, "service");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.ts"), serviceClientSource(app, appResources));
    }
  }
};

const resources = parseYaml(readFileSync(resourcesPath, "utf8")) as RawCatalog;
const applications = parseYaml(readFileSync(applicationsPath, "utf8")) as RawApplications;
const catalog = buildCatalog(resources);
writeCatalog(catalog);
writeBffWorkers(applications, resources);
writeServiceClients(applications, resources);
writeWranglerBindings(applications);

console.log("generated platform catalog, BFF proxy workers, service clients, and wrangler bindings");
