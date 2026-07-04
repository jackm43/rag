export type RegistrySecurityScheme = "cfAccess" | "betterAuthSession";

export type RegistryRouteBinding = {
  path: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  operationId: string;
  summary: string;
  description?: string;
  security?: readonly RegistrySecurityScheme[];
  parameters?: readonly unknown[];
  requestBody?: unknown;
  responses: Record<string, unknown>;
};

export const REGISTRY_APPLICATION = {
  title: "ragbot registry",
  description:
    "Control-plane application for registering ragbot applications, storing application metadata, initiating scaffolds, and checking artifact attestation readiness.",
  version: "1.0.0",
  serverUrl: "https://registry.jsmunro.me",
} as const;

export const REGISTRY_SECURITY_SCHEMES = {
  cfAccess: {
    type: "http",
    scheme: "bearer",
    description: "Cloudflare Access perimeter token.",
  },
  betterAuthSession: {
    type: "apiKey",
    in: "cookie",
    name: "better-auth.session_token",
    description: "Better Auth Discord session bound to the Access identity.",
  },
} as const satisfies Record<RegistrySecurityScheme, unknown>;

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

const applicationIdParameter = {
  name: "id",
  in: "path",
  required: true,
  schema: {
    type: "string",
    pattern: "^[a-z][a-z0-9-]{2,63}$",
  },
} as const;

const applicationRequestBody = {
  required: true,
  content: {
    "application/json": {
      schema: {
        $ref: "#/components/schemas/ApplicationRequest",
      },
    },
  },
} as const;

const registrySecurity = ["cfAccess", "betterAuthSession"] as const;

export const REGISTRY_SCHEMAS = {
  ApplicationRequest: {
    type: "object",
    required: ["id", "displayName", "zone", "targets", "operations", "routes"],
    properties: {
      id: { type: "string", pattern: "^[a-z][a-z0-9-]{2,63}$" },
      displayName: { type: "string" },
      description: { type: "string" },
      zone: { type: "string" },
      targets: { type: "array", items: { type: "string" } },
      operations: { type: "array", items: { type: "string" } },
      routes: {
        type: "array",
        items: {
          type: "object",
          required: ["method", "path", "operationId", "serviceOperation"],
          properties: {
            method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
            path: { type: "string" },
            operationId: { type: "string" },
            serviceOperation: { type: "string" },
          },
        },
      },
    },
  },
} as const;

export const REGISTRY_ROUTE_BINDINGS = [
  {
    path: "/openapi.json",
    method: "GET",
    operationId: "registryOpenApiJson",
    summary: "Registry generated OpenAPI document",
    security: ["cfAccess"],
    responses: {
      "200": jsonObjectResponse("Generated OpenAPI document."),
    },
  },
  {
    path: "/health",
    method: "GET",
    operationId: "registryHealth",
    summary: "Registry service health",
    security: ["cfAccess"],
    responses: {
      "200": jsonObjectResponse("Health snapshot."),
    },
  },
  {
    path: "/",
    method: "GET",
    operationId: "registryIndex",
    summary: "Registry text landing response",
    security: ["cfAccess"],
    responses: {
      "200": { description: "Text response." },
    },
  },
  {
    path: "/api/auth/{path}",
    method: "GET",
    operationId: "registryAuthGet",
    summary: "Better Auth session and OAuth endpoints",
    description: "Wildcard route owned by Better Auth under /api/auth/*, still behind Cloudflare Access.",
    security: ["cfAccess"],
    parameters: [
      {
        name: "path",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    responses: {
      "200": jsonObjectResponse("Better Auth response."),
      "401": { description: "Missing or invalid Access token." },
    },
  },
  {
    path: "/api/auth/{path}",
    method: "POST",
    operationId: "registryAuthPost",
    summary: "Better Auth session and OAuth endpoints",
    description: "Wildcard route owned by Better Auth under /api/auth/*, still behind Cloudflare Access.",
    security: ["cfAccess"],
    parameters: [
      {
        name: "path",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
    ],
    responses: {
      "200": jsonObjectResponse("Better Auth response."),
      "401": { description: "Missing or invalid Access token." },
    },
  },
  {
    path: "/api/applications",
    method: "GET",
    operationId: "listApplications",
    summary: "List registered applications",
    security: registrySecurity,
    responses: {
      "200": jsonObjectResponse("Application list."),
    },
  },
  {
    path: "/api/applications",
    method: "POST",
    operationId: "createApplication",
    summary: "Request a new application registration",
    security: registrySecurity,
    requestBody: applicationRequestBody,
    responses: {
      "202": jsonObjectResponse("Application request accepted."),
      "400": { description: "Invalid request." },
    },
  },
  {
    path: "/api/applications/{id}",
    method: "GET",
    operationId: "getApplication",
    summary: "Read one registered application",
    security: registrySecurity,
    parameters: [applicationIdParameter],
    responses: {
      "200": jsonObjectResponse("Application metadata."),
      "404": { description: "Application not found." },
    },
  },
  {
    path: "/api/applications/{id}",
    method: "PUT",
    operationId: "updateApplication",
    summary: "Update an application registration request",
    security: registrySecurity,
    parameters: [applicationIdParameter],
    requestBody: applicationRequestBody,
    responses: {
      "202": jsonObjectResponse("Application update accepted."),
      "404": { description: "Application not found." },
    },
  },
  {
    path: "/api/applications/{id}",
    method: "DELETE",
    operationId: "deleteApplication",
    summary: "Mark an application registration deleted",
    security: registrySecurity,
    parameters: [applicationIdParameter],
    responses: {
      "202": jsonObjectResponse("Application marked deleted."),
      "404": { description: "Application not found." },
    },
  },
  {
    path: "/api/applications/{id}/attestations/verify",
    method: "POST",
    operationId: "verifyApplicationAttestations",
    summary: "Verify scaffold artifact attestations",
    security: registrySecurity,
    parameters: [applicationIdParameter],
    responses: {
      "200": jsonObjectResponse("Attestation verification snapshot."),
      "404": { description: "Application or scaffold not found." },
    },
  },
] as const satisfies readonly RegistryRouteBinding[];
