// AUTO-GENERATED from the application bindings by
// scripts/generate-openapi.ts (`pnpm run routes:build`). Do not edit.

export const OPENAPI = {
  "openapi": "3.1.0",
  "info": {
    "title": "ragbot metadata",
    "description": "GraphQL metadata application for resolving registered application shapes, authorization metadata, and artifact attestation state.",
    "version": "1.0.0"
  },
  "servers": [
    {
      "url": "https://metadata.jsmunro.me"
    }
  ],
  "paths": {
    "/openapi.json": {
      "get": {
        "operationId": "metadataOpenApiJson",
        "summary": "Metadata generated OpenAPI document",
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
        "operationId": "metadataHealth",
        "summary": "Metadata service health",
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
    "/.well-known/metadata-configuration": {
      "get": {
        "operationId": "metadataConfiguration",
        "summary": "Metadata resolver discovery",
        "responses": {
          "200": {
            "description": "Metadata resolver discovery document.",
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
    "/graphql": {
      "post": {
        "operationId": "metadataGraphql",
        "summary": "GraphQL metadata resolver",
        "security": [
          {
            "metadataQueryToken": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "query"
                ],
                "properties": {
                  "query": {
                    "type": "string"
                  },
                  "variables": {
                    "type": "object",
                    "additionalProperties": true
                  },
                  "operationName": {
                    "type": "string"
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "GraphQL response.",
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
            "description": "Missing or invalid metadata query token."
          },
          "415": {
            "description": "Request body is not JSON."
          }
        }
      }
    }
  },
  "components": {
    "securitySchemes": {
      "metadataQueryToken": {
        "type": "http",
        "scheme": "bearer"
      }
    }
  }
} as const;
