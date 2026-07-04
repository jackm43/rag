export type AttestRouteBinding = {
  path: string;
  method: "GET" | "POST";
  operationId: string;
  summary: string;
  description?: string;
  responses: Record<string, unknown>;
};

export const ATTEST_APPLICATION = {
  title: "ragbot attest",
  description:
    "Public API for receiving GitHub webhook events and recording artifact attestations for registered ragbot application artifacts.",
  version: "1.0.0",
  serverUrl: "https://attest.jsmunro.me",
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

export const ATTEST_ROUTE_BINDINGS = [
  {
    path: "/openapi.json",
    method: "GET",
    operationId: "attestOpenApiJson",
    summary: "Attestation generated OpenAPI document",
    responses: {
      "200": jsonObjectResponse("Generated OpenAPI document."),
    },
  },
  {
    path: "/health",
    method: "GET",
    operationId: "attestHealth",
    summary: "Attestation service health",
    responses: {
      "200": jsonObjectResponse("Health snapshot."),
    },
  },
  {
    path: "/github",
    method: "POST",
    operationId: "githubWebhook",
    summary: "GitHub artifact attestation webhook",
    description:
      "Receives verified GitHub webhook events, resolves attested application artifact paths from the corresponding commit tree, and stores hashes in the AttestationStore Durable Object.",
    responses: {
      "202": jsonObjectResponse("Webhook accepted or ignored."),
      "401": { description: "Missing or invalid GitHub webhook signature." },
      "405": { description: "Method other than POST." },
    },
  },
] as const satisfies readonly AttestRouteBinding[];
