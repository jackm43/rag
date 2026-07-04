export type DevProxySecurityScheme = "cfAccess" | "betterAuthSession";
export type DevProxyMethod = "GET" | "POST" | "PUT";

export type DevProxyRouteBinding = {
  path: string;
  method: DevProxyMethod;
  operationId: string;
  summary: string;
  description?: string;
  security?: readonly DevProxySecurityScheme[];
  parameters?: readonly unknown[];
  requestBody?: unknown;
  responses: Record<string, unknown>;
};

export const DEV_PROXY_APPLICATION = {
  title: "ragbot admin (dev-proxy)",
  description:
    "Human-facing admin application. Requests first pass Cloudflare Access; command and connector operations additionally require a Better Auth Discord session bound to the Access identity.",
  version: "2.0.0",
  serverUrl: "https://ragbot-dev.jsmunro.me",
} as const;

export const DEV_PROXY_SECURITY_SCHEMES = {
  cfAccess: {
    type: "apiKey",
    in: "header",
    name: "Cf-Access-Jwt-Assertion",
    description: "Cloudflare Access application token. Browser requests may also present the Access cookie.",
  },
  betterAuthSession: {
    type: "apiKey",
    in: "cookie",
    name: "better-auth.session_token",
    description: "Better Auth Discord session bound to the Cloudflare Access identity.",
  },
} as const satisfies Record<DevProxySecurityScheme, unknown>;

const accessOnly = ["cfAccess"] as const;
const sessionSecurity = ["cfAccess", "betterAuthSession"] as const;

const connectorIdParameter = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$" },
} as const;

const jsonObjectResponse = (description: string) => ({
  description,
  content: {
    "application/json": {
      schema: {
        type: "object",
        additionalProperties: true,
      },
    },
  },
});

const htmlResponse = (description: string) => ({
  description,
  content: {
    "text/html": {
      schema: { type: "string" },
    },
  },
});

const jsonBody = (schema: unknown) => ({
  required: true,
  content: {
    "application/json": { schema },
  },
});

export const DEV_PROXY_SCHEMAS = {
  CommandOption: {
    type: "object",
    required: ["name", "value"],
    properties: {
      name: { type: "string", maxLength: 32 },
      value: { type: "string", maxLength: 4000 },
    },
  },
  CommandRequest: {
    type: "object",
    required: ["command"],
    properties: {
      command: { type: "string", pattern: "^[a-z][a-z0-9_]{0,31}$" },
      channelId: { type: "string", pattern: "^\\d{17,20}$" },
      options: {
        type: "array",
        maxItems: 25,
        items: { $ref: "#/components/schemas/CommandOption" },
      },
    },
  },
  GithubApiRequest: {
    type: "object",
    required: ["installationId"],
    properties: {
      installationId: { type: "string", pattern: "^\\d{1,20}$" },
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
      path: { type: "string", pattern: "^/", maxLength: 2048 },
      route: { type: "string", pattern: "^(GET|POST|PUT|PATCH|DELETE)\\s+/", maxLength: 2048 },
      params: {
        type: "object",
        additionalProperties: { oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] },
      },
      headers: { type: "object", additionalProperties: { type: "string", maxLength: 4096 } },
      body: { type: "string", maxLength: 1048576 },
    },
  },
  SetConnectorSecretRequest: {
    type: "object",
    required: ["provider"],
    properties: {
      provider: {
        type: "string",
        enum: ["wrangler-env", "cloudflare-secret-store", "hashicorp-vault", "onepassword"],
      },
      ref: { type: "string", maxLength: 512 },
      value: { type: "string", maxLength: 65536 },
    },
  },
  CompleteAuthorizationRequest: {
    type: "object",
    required: ["code", "state"],
    properties: {
      code: { type: "string", maxLength: 2048 },
      state: { type: "string", maxLength: 2048 },
    },
  },
  GrantAuthorizationResult: {
    type: "object",
    required: ["url", "state", "connectorId"],
    properties: {
      url: { type: "string" },
      state: { type: "string" },
      connectorId: { type: "string" },
    },
  },
  CompleteAuthorizationResult: {
    type: "object",
    required: ["authorized", "connectorId"],
    properties: {
      authorized: { type: "boolean" },
      connectorId: { type: "string" },
    },
  },
} as const;

const standardJsonResponses = {
  "200": jsonObjectResponse("Request succeeded."),
  "400": { description: "Malformed request." },
  "401": { description: "Missing or invalid Access token, or no valid Better Auth session." },
  "403": { description: "The authenticated subject is not authorized for the requested operation." },
  "502": { description: "Upstream service or connector broker error." },
} as const;

export const DEV_PROXY_ROUTE_BINDINGS = [
  {
    path: "/openapi.json",
    method: "GET",
    operationId: "devProxyOpenApiJson",
    summary: "Dev-proxy generated OpenAPI document",
    security: accessOnly,
    responses: { "200": jsonObjectResponse("Generated OpenAPI document.") },
  },
  {
    path: "/",
    method: "GET",
    operationId: "devProxyPage",
    summary: "The dev-proxy single-page admin UI",
    security: accessOnly,
    responses: { "200": htmlResponse("HTML page.") },
  },
  {
    path: "/apis",
    method: "GET",
    operationId: "devProxyApiWorkbenchPage",
    summary: "The dev-proxy API workbench view",
    security: accessOnly,
    responses: { "200": htmlResponse("HTML page.") },
  },
  {
    path: "/github",
    method: "GET",
    operationId: "devProxyGithubPage",
    summary: "The dev-proxy GitHub API browser view",
    security: accessOnly,
    responses: { "200": htmlResponse("HTML page.") },
  },
  {
    path: "/api/auth/{path}",
    method: "GET",
    operationId: "devProxyAuthGet",
    summary: "Better Auth session and OAuth endpoints",
    security: accessOnly,
    parameters: [
      { name: "path", in: "path", required: true, schema: { type: "string" } },
    ],
    responses: {
      "200": jsonObjectResponse("Better Auth response."),
      "401": { description: "Missing or invalid Access token." },
    },
  },
  {
    path: "/api/auth/{path}",
    method: "POST",
    operationId: "devProxyAuthPost",
    summary: "Better Auth session and OAuth endpoints",
    security: accessOnly,
    parameters: [
      { name: "path", in: "path", required: true, schema: { type: "string" } },
    ],
    responses: {
      "200": jsonObjectResponse("Better Auth response."),
      "401": { description: "Missing or invalid Access token." },
    },
  },
  {
    path: "/api/command",
    method: "POST",
    operationId: "devProxyCommand",
    summary: "Proxy a slash command through the gateway",
    security: sessionSecurity,
    requestBody: jsonBody({ $ref: "#/components/schemas/CommandRequest" }),
    responses: standardJsonResponses,
  },
  {
    path: "/api/github",
    method: "POST",
    operationId: "callGithubApi",
    summary: "Call a GitHub API through the GitHub App connector",
    security: sessionSecurity,
    requestBody: jsonBody({ $ref: "#/components/schemas/GithubApiRequest" }),
    responses: standardJsonResponses,
  },
  {
    path: "/api/github/routes",
    method: "GET",
    operationId: "listGithubRoutes",
    summary: "List known GitHub REST API routes",
    security: accessOnly,
    responses: {
      "200": jsonObjectResponse("GitHub REST API route catalog."),
      "401": { description: "Missing or invalid Access token." },
      "503": { description: "Route catalog is not provisioned in the runtime bucket." },
    },
  },
  {
    path: "/api/connectors",
    method: "GET",
    operationId: "listConnectors",
    summary: "List connectors and their secret status",
    security: sessionSecurity,
    responses: standardJsonResponses,
  },
  {
    path: "/api/connectors/{id}",
    method: "GET",
    operationId: "describeConnector",
    summary: "Describe one connector's config and status",
    security: sessionSecurity,
    parameters: [connectorIdParameter],
    responses: { ...standardJsonResponses, "404": { description: "Unknown connector." } },
  },
  {
    path: "/api/connectors/{id}/secret",
    method: "PUT",
    operationId: "setConnectorSecret",
    summary: "Set or re-point a connector's secret",
    security: sessionSecurity,
    parameters: [connectorIdParameter],
    requestBody: jsonBody({ $ref: "#/components/schemas/SetConnectorSecretRequest" }),
    responses: {
      ...standardJsonResponses,
      "202": jsonObjectResponse("Connector re-pointed; out-of-band provisioning is required."),
      "404": { description: "Unknown connector." },
      "409": jsonObjectResponse("The operation was refused and nothing was persisted."),
    },
  },
  {
    path: "/api/connectors/{id}/grant",
    method: "POST",
    operationId: "connectorGrant",
    summary: "Begin an admin-initiated 3LO authorization",
    security: sessionSecurity,
    parameters: [connectorIdParameter],
    responses: { ...standardJsonResponses, "404": { description: "Unknown connector." } },
  },
  {
    path: "/api/connectors/{id}/installations",
    method: "GET",
    operationId: "listConnectorInstallations",
    summary: "List a github_app connector's App installations",
    security: sessionSecurity,
    parameters: [connectorIdParameter],
    responses: { ...standardJsonResponses, "404": { description: "Unknown connector." } },
  },
  {
    path: "/api/connectors/{id}/callback",
    method: "GET",
    operationId: "connectorCallbackGet",
    summary: "3LO provider redirect callback",
    security: sessionSecurity,
    parameters: [
      connectorIdParameter,
      { name: "code", in: "query", required: false, schema: { type: "string", maxLength: 2048 } },
      { name: "state", in: "query", required: false, schema: { type: "string", maxLength: 2048 } },
      { name: "error", in: "query", required: false, schema: { type: "string" } },
      { name: "error_description", in: "query", required: false, schema: { type: "string" } },
    ],
    responses: {
      "200": htmlResponse("Authorization complete."),
      "400": htmlResponse("Provider denial or missing callback parameters."),
      "401": { description: "Missing or invalid Access token, or no valid Better Auth session." },
      "403": htmlResponse("The broker refused completion."),
      "404": { description: "Unknown connector." },
      "502": htmlResponse("The broker's code-for-token exchange failed."),
    },
  },
  {
    path: "/api/connectors/{id}/callback",
    method: "POST",
    operationId: "connectorCallbackPost",
    summary: "3LO completion API variant",
    security: sessionSecurity,
    parameters: [connectorIdParameter],
    requestBody: jsonBody({ $ref: "#/components/schemas/CompleteAuthorizationRequest" }),
    responses: { ...standardJsonResponses, "404": { description: "Unknown connector." } },
  },
  {
    path: "/api/secrets/providers",
    method: "GET",
    operationId: "getSecretsProviders",
    summary: "List secrets backends and runtime write capability",
    security: sessionSecurity,
    responses: standardJsonResponses,
  },
] as const satisfies readonly DevProxyRouteBinding[];
