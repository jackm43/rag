// AUTO-GENERATED from gateway application bindings by
// scripts/generate-gateway-routes.ts (`pnpm run routes:build`). Do not edit.

export const OPENAPI = {
  "openapi": "3.1.0",
  "info": {
    "title": "ragbot gateway",
    "description": "Public surface of the ragbot gateway application. Generated applications use their own middleware clients and the gateway's non-public ApplicationMiddleware WorkerEntrypoint; service-to-service contracts remain Cap'n Proto.",
    "version": "1.0.0"
  },
  "servers": [
    {
      "url": "https://ragbot.jsmunro.me"
    }
  ],
  "paths": {
    "/openapi.json": {
      "get": {
        "operationId": "openApiJson",
        "summary": "Gateway generated OpenAPI document",
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
    "/.well-known/oauth-authorization-server": {
      "get": {
        "operationId": "oauthAuthorizationServerMetadata",
        "summary": "Gateway OAuth authorization server discovery",
        "responses": {
          "200": {
            "description": "Discovery document.",
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
    "/.well-known/openid-configuration": {
      "get": {
        "operationId": "openidConfiguration",
        "summary": "Gateway OpenID Connect discovery",
        "responses": {
          "200": {
            "description": "Discovery document.",
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
    "/.well-known/jwks.json": {
      "get": {
        "operationId": "jwks",
        "summary": "Gateway JSON Web Key Set",
        "description": "RFC 7517 JWK Set of the committed service-identity public keyring, for verifying Ed25519 (EdDSA) signed identity-context tokens minted by ragbot workers.",
        "responses": {
          "200": {
            "description": "JWK Set document.",
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
    "/discord": {
      "post": {
        "operationId": "discordInteraction",
        "summary": "Discord interactions endpoint",
        "description": "Receives Discord interaction callbacks. Every request must carry a valid Ed25519 signature over timestamp+body, signed with the Discord application's key.",
        "security": [
          {
            "discordSignature": []
          }
        ],
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "$ref": "#/components/schemas/DiscordInteraction"
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Interaction response payload.",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/InteractionResponse"
                }
              }
            }
          },
          "401": {
            "description": "Missing, malformed, stale, or invalid request signature."
          },
          "405": {
            "description": "Method other than POST."
          }
        }
      }
    },
    "/gateway/start": {
      "post": {
        "operationId": "startGateway",
        "summary": "Start the Discord gateway connection",
        "security": [
          {
            "controlToken": []
          }
        ],
        "responses": {
          "200": {
            "description": "Gateway start result.",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/GatewayControlResult"
                }
              }
            }
          },
          "401": {
            "description": "Missing or invalid control bearer token."
          },
          "403": {
            "description": "Authenticated gateway-control application denied by policy."
          },
          "405": {
            "description": "Method other than POST."
          }
        }
      }
    },
    "/gateway/stop": {
      "post": {
        "operationId": "stopGateway",
        "summary": "Stop the Discord gateway connection",
        "security": [
          {
            "controlToken": []
          }
        ],
        "responses": {
          "200": {
            "description": "Gateway stop result.",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/GatewayControlResult"
                }
              }
            }
          },
          "401": {
            "description": "Missing or invalid control bearer token."
          },
          "403": {
            "description": "Authenticated gateway-control application denied by policy."
          },
          "405": {
            "description": "Method other than POST."
          }
        }
      }
    },
    "/gateway/health": {
      "get": {
        "operationId": "gatewayHealth",
        "summary": "Discord gateway connection health",
        "security": [
          {
            "controlToken": []
          }
        ],
        "responses": {
          "200": {
            "description": "Gateway health snapshot.",
            "content": {
              "application/json": {
                "schema": {
                  "$ref": "#/components/schemas/GatewayControlResult"
                }
              }
            }
          },
          "401": {
            "description": "Missing or invalid control bearer token."
          },
          "403": {
            "description": "Authenticated gateway-control application denied by policy."
          },
          "405": {
            "description": "Method other than GET."
          }
        }
      }
    }
  },
  "components": {
    "securitySchemes": {
      "discordSignature": {
        "type": "apiKey",
        "in": "header",
        "name": "X-Signature-Ed25519",
        "description": "Discord interaction signing: X-Signature-Ed25519 plus X-Signature-Timestamp, verified against the application's public key."
      },
      "controlToken": {
        "type": "http",
        "scheme": "bearer",
        "description": "Gateway control-plane bearer token (GATEWAY_CONTROL_TOKEN secret)."
      }
    },
    "schemas": {
      "DiscordInteraction": {
        "type": "object",
        "description": "Discord interaction payload (subset validated by the worker).",
        "required": [
          "type"
        ],
        "properties": {
          "type": {
            "type": "integer"
          },
          "application_id": {
            "type": "string"
          },
          "guild_id": {
            "type": "string"
          },
          "channel_id": {
            "type": "string"
          },
          "token": {
            "type": "string"
          },
          "data": {
            "type": "object",
            "additionalProperties": true
          }
        }
      },
      "InteractionResponse": {
        "type": "object",
        "required": [
          "type"
        ],
        "properties": {
          "type": {
            "type": "integer"
          },
          "data": {
            "type": "object",
            "additionalProperties": true
          }
        }
      },
      "GatewayControlResult": {
        "type": "object",
        "additionalProperties": true
      }
    }
  }
} as const;
