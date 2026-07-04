import YAML from "yaml";

import type {
  RegistryApplicationMetadata,
  RegistryArtifact,
  RegistryRoute,
  RegistryScaffold,
} from "./types";

const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export const sha256Hex = async (content: string): Promise<string> =>
  hex(await crypto.subtle.digest("SHA-256", encoder.encode(content)));

const metadataPath = (id: string) => `registry/applications/${id}.yaml`;
// A scaffolded application is a workspace app of its own: apps/<id> holds the
// worker pair plus the package.json that lets it import the shared @rag/*
// packages (pnpm-workspace.yaml already globs apps/*).
const appRoot = (id: string) => `apps/${id}`;
const workerRoot = (id: string) => `${appRoot(id)}/workers/${id}`;
const middlewareRoot = (id: string) => `${workerRoot(id)}/api/middleware_client`;
const serviceServerRoot = (id: string) => `${workerRoot(id)}/service_server`;
const webRoot = (id: string) => `${workerRoot(id)}/web`;

const stableMetadata = (metadata: RegistryApplicationMetadata) => ({
  id: metadata.id,
  displayName: metadata.displayName,
  description: metadata.description ?? "",
  owner: {
    discordId: metadata.ownerDiscordId,
    accessSub: metadata.ownerAccessSub,
  },
  zone: metadata.zone,
  status: metadata.status,
  requestedAt: metadata.requestedAt,
  targets: metadata.targets,
  operations: metadata.operations,
  routes: metadata.routes,
});

const routeMatcherSource = (routes: RegistryRoute[]): string =>
  JSON.stringify(routes, null, 2);

const uniqueRoutesByServiceOperation = (routes: RegistryRoute[]): RegistryRoute[] => {
  const seen = new Set<string>();
  const unique: RegistryRoute[] = [];
  for (const route of routes) {
    if (!seen.has(route.serviceOperation)) {
      seen.add(route.serviceOperation);
      unique.push(route);
    }
  }
  return unique;
};

const methodName = (operation: string, index = 0): string => {
  const parts = operation.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const suffix = parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
  return `handle${suffix || "ApplicationRequest"}${index}`;
};

const middlewareBindingsSource = (metadata: RegistryApplicationMetadata): string => `export const APPLICATION_ID = "${metadata.id}";
export const APPLICATION_ROUTES = ${routeMatcherSource(metadata.routes)} as const;
`;

const middlewareOpenApiSource = (metadata: RegistryApplicationMetadata): string => `import { APPLICATION_ID, APPLICATION_ROUTES } from "./application-bindings";

const operationFor = (route: typeof APPLICATION_ROUTES[number]) => ({
  operationId: route.operationId,
  "x-rag-application-id": APPLICATION_ID,
  "x-rag-service-operation": route.serviceOperation,
  responses: {
    "200": { description: "Application response" },
    "400": { description: "Request validation failed before gateway forwarding" },
    "401": { description: "Authentication required" },
    "403": { description: "Authorization denied" },
  },
});

export const OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "${metadata.displayName} API",
    version: "0.1.0",
    description: ${JSON.stringify(metadata.description ?? `Generated middleware API for ${metadata.displayName}.`)},
  },
  paths: Object.fromEntries(APPLICATION_ROUTES.map((route) => [
    route.path,
    { [route.method.toLowerCase()]: operationFor(route) },
  ])),
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" },
    },
  },
} as const;
`;

const middlewareSource = (metadata: RegistryApplicationMetadata): string => `import { APPLICATION_ID, APPLICATION_ROUTES } from "./application-bindings";
import { OPENAPI } from "./openapi";

type Env = {
  LINKED_APP_TOKEN?: string;
  // Internal service binding to the gateway application. The middleware client
  // validates and annotates the request, then forwards it across this binding.
  GATEWAY?: {
    prepare: (request: Request) => Promise<
      | { ok: true; message: Uint8Array }
      | { ok: false; status: number; error: string }
    >;
  };
  SERVICE_SERVER?: {
    invoke: (message: Uint8Array) => Promise<Response>;
  };
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const pathMatches = (template: string, pathname: string): boolean => {
  const templateParts = template.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  if (templateParts.length !== pathParts.length) {
    return false;
  }
  return templateParts.every((part, index) => part.startsWith("{") && part.endsWith("}") || part === pathParts[index]);
};

const routeFor = (request: Request): typeof APPLICATION_ROUTES[number] | null => {
  const url = new URL(request.url);
  return APPLICATION_ROUTES.find((route) =>
    route.method === request.method && pathMatches(route.path, url.pathname)
  ) ?? null;
};

const forwardedRequest = (
  request: Request,
  route: typeof APPLICATION_ROUTES[number],
  linkedAppToken: string,
): Request => {
  const headers = new Headers(request.headers);
  headers.set("x-rag-application-id", APPLICATION_ID);
  headers.set("x-rag-operation-id", route.operationId);
  headers.set("x-rag-service-operation", route.serviceOperation);
  // The gateway never receives the raw linked app token in the signed payload:
  // it hashes this header and signs only the fingerprint into application.request.
  // The generated service server compares that fingerprint against its configured
  // expected hash before dispatching app code.
  headers.set("x-rag-linked-app-token", linkedAppToken);
  return new Request(request, { headers });
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json(200, { ok: true, application: APPLICATION_ID, role: "middleware_client" });
    }

    if (request.method === "GET" && url.pathname === "/openapi.json") {
      return json(200, OPENAPI);
    }

    const route = routeFor(request);
    if (!route) {
      return json(404, { error: "not_found" });
    }

    if (!env.GATEWAY || !env.SERVICE_SERVER || !env.LINKED_APP_TOKEN) {
      return json(503, { error: "application_bindings_unavailable" });
    }

    const prepared = await env.GATEWAY.prepare(forwardedRequest(request, route, env.LINKED_APP_TOKEN));
    if (!prepared.ok) {
      return json(prepared.status, { error: prepared.error });
    }
    return env.SERVICE_SERVER.invoke(prepared.message);
  },
};
`;

const serviceServerManifestSource = (metadata: RegistryApplicationMetadata): string => `import type { MachinePrincipal, TrustZone } from "@rag/service-kit/principal";
import type { ServiceManifest } from "@rag/service-kit/manifest";

// Generated app servers receive a generic application.request service envelope.
// The concrete application id remains in the payload and must match
// REGISTRY_APPLICATION_ID at receive time. Each request carries the linked app
// token fingerprint signed into the payload by the gateway.
export const MANIFEST = {
  service: "application-service" as MachinePrincipal,
  zone: "application" as TrustZone,
  targets: [] as MachinePrincipal[],
  operations: ["application.request"],
} satisfies ServiceManifest;
`;

const serviceServerHandlersSource = (metadata: RegistryApplicationMetadata): string => {
  const routes = uniqueRoutesByServiceOperation(metadata.routes);
  const handlerTypes = `import type { ServiceRequest } from "@rag/service-kit";
import type { ApplicationRequestJob } from "@rag/egress/contracts";

export type ApplicationHandler = (request: ServiceRequest<ApplicationRequestJob>) => Response | Promise<Response>;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
`;
  const handlers = routes.map((route, index) => `
export const ${methodName(route.serviceOperation, index)}: ApplicationHandler = async (request) =>
  json(501, {
    error: "application_method_not_implemented",
    applicationId: request.payload.applicationId,
    operationId: request.payload.operationId,
    serviceOperation: request.payload.serviceOperation,
    method: request.payload.method,
    route: ${JSON.stringify({ method: route.method, path: route.path, operationId: route.operationId })},
  });
`).join("");
  const entries = routes.map((route, index) =>
    `  ${JSON.stringify(route.serviceOperation)}: ${methodName(route.serviceOperation, index)},`
  ).join("\n");
  return `${handlerTypes}${handlers}
export const APPLICATION_HANDLERS: Record<string, ApplicationHandler> = {
${entries}
};
`;
};

const serviceServerSource = (metadata: RegistryApplicationMetadata): string => `import { WorkerEntrypoint } from "cloudflare:workers";

import { createServiceServer, ensureRegistered } from "@rag/service-kit";
import { decodeApplicationRequestEnvelope } from "@rag/egress/contracts";
import type { EgressEnv } from "@rag/egress/contracts";
import type { ServiceMessageBytes } from "@rag/contracts-core";
import type { ServiceKitEnv } from "@rag/service-kit/env";
import { APPLICATION_HANDLERS } from "./handlers";
import { MANIFEST } from "./manifest";

type Env = Cloudflare.Env & ServiceKitEnv & EgressEnv;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const server = (env: Env) => createServiceServer({
  self: "application-service",
  expectedIssuers: ["gateway"],
  operations: MANIFEST.operations,
  env,
});

const linkedTokenMatches = (env: Env, actual: string): boolean =>
  typeof env.LINKED_APP_TOKEN_SHA256 === "string" &&
  env.LINKED_APP_TOKEN_SHA256.length > 0 &&
  env.LINKED_APP_TOKEN_SHA256 === actual;

export class ApplicationService extends WorkerEntrypoint<Env> {
  async invoke(message: ServiceMessageBytes): Promise<Response> {
    await ensureRegistered(this.env, MANIFEST);
    const request = await server(this.env).receive(message, decodeApplicationRequestEnvelope, "binding");
    if (!request) {
      return json(403, { error: "application_request_denied" });
    }
    if (request.payload.applicationId !== "${metadata.id}") {
      return json(403, { error: "application_mismatch" });
    }
    if (!linkedTokenMatches(this.env, request.payload.linkedTokenSha256)) {
      return json(403, { error: "linked_app_token_denied" });
    }
    const handler = APPLICATION_HANDLERS[request.payload.serviceOperation];
    if (!handler) {
      return json(404, { error: "application_method_not_found" });
    }
    return handler(request);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      ctx.waitUntil(ensureRegistered(env, MANIFEST));
      return json(200, { ok: true, application: "${metadata.id}", role: "service_server" });
    }

    return json(404, { error: "not_found" });
  },
};
`;

const middlewareWranglerSource = (metadata: RegistryApplicationMetadata): string => `${JSON.stringify({
  name: `ragbot-${metadata.id}-api-worker`,
  main: "src/index.ts",
  compatibility_date: "2026-04-23",
  compatibility_flags: ["nodejs_compat"],
  workers_dev: false,
  vars: {
    REGISTRY_APPLICATION_ID: metadata.id,
  },
  services: [
    {
      binding: "GATEWAY",
      service: "ragbot-worker",
      entrypoint: "ApplicationMiddleware",
    },
    {
      binding: "SERVICE_SERVER",
      service: `ragbot-${metadata.id}-service-worker`,
      entrypoint: "ApplicationService",
    },
  ],
  observability: {
    logs: { enabled: true, invocation_logs: true },
    traces: { enabled: true },
  },
}, null, 2)}
`;

const serviceServerWranglerSource = (metadata: RegistryApplicationMetadata): string => `${JSON.stringify({
  name: `ragbot-${metadata.id}-service-worker`,
  main: "src/index.ts",
  compatibility_date: "2026-04-23",
  compatibility_flags: ["nodejs_compat"],
  workers_dev: false,
  rules: [
    {
      type: "Text",
      globs: ["**/*.cedar"],
      fallthrough: true,
    },
  ],
  vars: {
    REGISTRY_APPLICATION_ID: metadata.id,
  },
  durable_objects: {
    bindings: [
      {
        name: "SERVICE_REGISTRY",
        class_name: "ServiceRegistry",
        script_name: "ragbot-registry-worker",
      },
    ],
  },
  observability: {
    logs: { enabled: true, invocation_logs: true },
    traces: { enabled: true },
  },
}, null, 2)}
`;

const appPackageJsonSource = (metadata: RegistryApplicationMetadata): string => `${JSON.stringify({
  name: `@rag/${metadata.id}`,
  version: "0.0.0",
  private: true,
  type: "module",
  exports: { "./*": "./*.ts" },
  dependencies: {
    "@rag/contracts-core": "workspace:*",
    "@rag/egress": "workspace:*",
    "@rag/service-kit": "workspace:*",
  },
}, null, 2)}
`;

const webReadmeSource = (metadata: RegistryApplicationMetadata): string => `# ${metadata.displayName} Web

This directory is reserved for the application web surface.

The generated API middleware client lives in \`../api/middleware_client\` and
exposes \`GET /openapi.json\`. The service server lives in
\`../service_server\` and owns the application service operations after the
control-plane topology trusts this application id.
`;

export const buildApplicationScaffold = async (
  metadata: RegistryApplicationMetadata,
): Promise<RegistryScaffold> => {
  const metadataYaml = YAML.stringify(stableMetadata(metadata), { sortMapEntries: true });
  const files: Array<{ path: string; content: string }> = [
    { path: metadataPath(metadata.id), content: metadataYaml },
    { path: `${appRoot(metadata.id)}/package.json`, content: appPackageJsonSource(metadata) },
    { path: `${middlewareRoot(metadata.id)}/src/application-bindings.ts`, content: middlewareBindingsSource(metadata) },
    { path: `${middlewareRoot(metadata.id)}/src/openapi.ts`, content: middlewareOpenApiSource(metadata) },
    { path: `${middlewareRoot(metadata.id)}/src/index.ts`, content: middlewareSource(metadata) },
    { path: `${middlewareRoot(metadata.id)}/wrangler.jsonc`, content: middlewareWranglerSource(metadata) },
    { path: `${serviceServerRoot(metadata.id)}/src/index.ts`, content: serviceServerSource(metadata) },
    { path: `${serviceServerRoot(metadata.id)}/src/handlers.ts`, content: serviceServerHandlersSource(metadata) },
    { path: `${serviceServerRoot(metadata.id)}/src/manifest.ts`, content: serviceServerManifestSource(metadata) },
    { path: `${serviceServerRoot(metadata.id)}/wrangler.jsonc`, content: serviceServerWranglerSource(metadata) },
    { path: `${webRoot(metadata.id)}/README.md`, content: webReadmeSource(metadata) },
  ];
  const artifacts: RegistryArtifact[] = [];
  for (const file of files) {
    artifacts.push({ ...file, sha256: await sha256Hex(file.content) });
  }
  return {
    applicationId: metadata.id,
    metadataSha256: await sha256Hex(metadataYaml),
    artifacts,
  };
};
