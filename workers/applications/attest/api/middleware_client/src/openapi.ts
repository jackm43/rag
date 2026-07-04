// AUTO-GENERATED from attest application bindings by
// scripts/generate-attest-openapi.ts (`npm run routes:build`). Do not edit.

export const OPENAPI = {
  "openapi": "3.1.0",
  "info": {
    "title": "ragbot attest",
    "description": "Public API for receiving GitHub webhook events and recording artifact attestations for registered ragbot application artifacts.",
    "version": "1.0.0"
  },
  "servers": [
    {
      "url": "https://attest.jsmunro.me"
    }
  ],
  "paths": {
    "/openapi.json": {
      "get": {
        "operationId": "attestOpenApiJson",
        "summary": "Attestation generated OpenAPI document",
        "responses": {
          "200": {
            "description": "Generated OpenAPI document.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "additionalProperties": true
                }
              }
            }
          }
        }
      }
    },
    "/health": {
      "get": {
        "operationId": "attestHealth",
        "summary": "Attestation service health",
        "responses": {
          "200": {
            "description": "Health snapshot.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "additionalProperties": true
                }
              }
            }
          }
        }
      }
    },
    "/github": {
      "post": {
        "operationId": "githubWebhook",
        "summary": "GitHub artifact attestation webhook",
        "description": "Receives verified GitHub webhook events, resolves attested application artifact paths from the corresponding commit tree, and stores hashes in the AttestationStore Durable Object.",
        "responses": {
          "202": {
            "description": "Webhook accepted or ignored.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "additionalProperties": true
                }
              }
            }
          },
          "401": {
            "description": "Missing or invalid GitHub webhook signature."
          },
          "405": {
            "description": "Method other than POST."
          }
        }
      }
    }
  }
} as const;
