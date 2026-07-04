export type WebhooksRouteBinding = {
  path: string;
  method: "GET" | "POST";
  operationId: string;
  summary: string;
  description?: string;
  security?: Array<Record<string, never[]>>;
  parameters?: unknown[];
  requestBody?: unknown;
  responses: Record<string, unknown>;
};

export const WEBHOOKS_APPLICATION = {
  title: "ragbot webhooks",
  description:
    "Public surface of the centralised webhook-ingress worker. Third-party providers POST signed webhook deliveries to /{provider}/{id}; signature verification happens in the connector service, and verified events are enqueued to workflows as Cap'n Proto ServiceMessages.",
  version: "1.0.0",
  serverUrl: "https://webhooks.jsmunro.me",
} as const;

export const WEBHOOKS_ROUTE_BINDINGS = [
  {
    path: "/openapi.json",
    method: "GET",
    operationId: "webhooksOpenApiJson",
    summary: "Webhooks generated OpenAPI document",
    responses: {
      "200": {
        description: "Generated OpenAPI document.",
        content: {
          "application/json": {
            schema: { type: "object", additionalProperties: true },
          },
        },
      },
    },
  },
  {
    path: "/{provider}/{id}",
    method: "POST",
    operationId: "receiveWebhook",
    summary: "Receive a provider webhook delivery",
    description:
      "Receives a signed webhook delivery for the connector named by {id}, using the signature scheme selected by {provider}. The raw body plus signature headers are handed to the connector service, which resolves the webhook secret and verifies the HMAC over the exact body bytes. Verified events are deduplicated on the provider event id within a 24h window.",
    security: [{ providerSignature: [] as never[] }],
    parameters: [
      {
        name: "provider",
        in: "path",
        required: true,
        description: "The signature scheme and provider.",
        schema: {
          type: "string",
          enum: ["github", "stripe"],
        },
      },
      {
        name: "id",
        in: "path",
        required: true,
        description: "The connector slug the delivery is addressed to.",
        schema: {
          type: "string",
          pattern: "^[a-z][a-z0-9-]{0,63}$",
        },
      },
    ],
    requestBody: {
      required: true,
      description:
        "The provider's raw webhook payload. Verified as exact bytes and capped at 64 KiB.",
      content: {
        "application/json": {
          schema: {
            type: "object",
            additionalProperties: true,
          },
        },
      },
    },
    responses: {
      "202": { description: "Signature verified; event enqueued for processing." },
      "200": { description: "Duplicate delivery acknowledged idempotently." },
      "401": { description: "Missing, malformed, or invalid signature." },
      "404": { description: "Unknown provider scheme or malformed connector slug." },
      "405": { description: "Method other than POST on a webhook path." },
      "413": { description: "Body larger than the 64 KiB cap." },
      "500": { description: "Verified but could not be enqueued; the provider should retry." },
    },
  },
] as const satisfies readonly WebhooksRouteBinding[];

export const WEBHOOKS_COMPONENTS = {
  securitySchemes: {
    providerSignature: {
      type: "apiKey",
      in: "header",
      name: "X-Hub-Signature-256",
      description:
        "Provider webhook signing over the exact body bytes, verified in the connector service.",
    },
  },
} as const;
