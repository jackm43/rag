import type { PlatformCatalog } from "./types";

export const PLATFORM_CATALOG = {
  "applications": {
    "idp": {
      "audience": "idp",
      "apiName": "gateway",
      "routePrefix": "/platform/gateway/v1/",
      "resources": [
        {
          "name": "DiscoveryService",
          "methods": [
            {
              "name": "Discover",
              "scope": "idp/DiscoveryService.Discover",
              "operationId": "discover",
              "http": {
                "method": "GET",
                "path": "/platform/gateway/v1/discovery"
              },
              "route": {
                "namespace": "platform",
                "apiName": "gateway",
                "version": "v1",
                "audience": "idp",
                "method": "GET",
                "path": "/platform/gateway/v1/discovery",
                "operationId": "discover",
                "summary": "DiscoveryService.Discover",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "idp/DiscoveryService.Discover"
                ],
                "tags": [
                  "discovery"
                ]
              }
            }
          ]
        },
        {
          "name": "IdentityService",
          "methods": [
            {
              "name": "Introspect",
              "scope": "idp/IdentityService.Introspect",
              "operationId": "introspect",
              "http": {
                "method": "GET",
                "path": "/platform/gateway/v1/identity/introspections"
              },
              "route": {
                "namespace": "platform",
                "apiName": "gateway",
                "version": "v1",
                "audience": "idp",
                "method": "GET",
                "path": "/platform/gateway/v1/identity/introspections",
                "operationId": "introspect",
                "summary": "IdentityService.Introspect",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "idp/IdentityService.Introspect"
                ],
                "tags": [
                  "identity"
                ]
              }
            },
            {
              "name": "ExchangeProviderToken",
              "scope": "idp/IdentityService.ExchangeProviderToken",
              "operationId": "exchangeProviderToken",
              "http": {
                "method": "POST",
                "path": "/platform/gateway/v1/provider/token/exchanges"
              },
              "route": {
                "namespace": "platform",
                "apiName": "gateway",
                "version": "v1",
                "audience": "idp",
                "method": "POST",
                "path": "/platform/gateway/v1/provider/token/exchanges",
                "operationId": "exchangeProviderToken",
                "summary": "IdentityService.ExchangeProviderToken",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "idp/IdentityService.ExchangeProviderToken"
                ],
                "tags": [
                  "identity"
                ]
              }
            }
          ]
        },
        {
          "name": "RegistryService",
          "methods": [
            {
              "name": "GetProviderConfig",
              "scope": "idp/RegistryService.GetProviderConfig",
              "operationId": "getProviderConfig",
              "http": {
                "method": "GET",
                "path": "/platform/gateway/v1/provider/config"
              },
              "route": {
                "namespace": "platform",
                "apiName": "gateway",
                "version": "v1",
                "audience": "idp",
                "method": "GET",
                "path": "/platform/gateway/v1/provider/config",
                "operationId": "getProviderConfig",
                "summary": "RegistryService.GetProviderConfig",
                "auth": "gateway-jwt",
                "identityContext": "none",
                "scopes": [
                  "idp/RegistryService.GetProviderConfig"
                ],
                "tags": [
                  "registry"
                ]
              }
            },
            {
              "name": "UpsertProviderConfig",
              "scope": "idp/RegistryService.UpsertProviderConfig",
              "operationId": "upsertProviderConfig",
              "http": {
                "method": "PUT",
                "path": "/platform/gateway/v1/provider/config"
              },
              "route": {
                "namespace": "platform",
                "apiName": "gateway",
                "version": "v1",
                "audience": "idp",
                "method": "PUT",
                "path": "/platform/gateway/v1/provider/config",
                "operationId": "upsertProviderConfig",
                "summary": "RegistryService.UpsertProviderConfig",
                "auth": "gateway-jwt",
                "identityContext": "none",
                "scopes": [
                  "idp/RegistryService.UpsertProviderConfig"
                ],
                "tags": [
                  "registry"
                ]
              }
            },
            {
              "name": "ListApplications",
              "scope": "idp/RegistryService.ListApplications",
              "operationId": "listApplications",
              "http": {
                "method": "GET",
                "path": "/platform/applications/v1/applications"
              },
              "route": {
                "namespace": "platform",
                "apiName": "gateway",
                "version": "v1",
                "audience": "idp",
                "method": "GET",
                "path": "/platform/applications/v1/applications",
                "operationId": "listApplications",
                "summary": "RegistryService.ListApplications",
                "auth": "gateway-jwt",
                "identityContext": "none",
                "scopes": [
                  "idp/RegistryService.ListApplications"
                ],
                "tags": [
                  "registry"
                ]
              }
            },
            {
              "name": "RegisterApplication",
              "scope": "idp/RegistryService.RegisterApplication",
              "operationId": "registerApplication",
              "http": {
                "method": "POST",
                "path": "/platform/applications/v1/applications"
              },
              "route": {
                "namespace": "platform",
                "apiName": "gateway",
                "version": "v1",
                "audience": "idp",
                "method": "POST",
                "path": "/platform/applications/v1/applications",
                "operationId": "registerApplication",
                "summary": "RegistryService.RegisterApplication",
                "auth": "gateway-jwt",
                "identityContext": "none",
                "scopes": [
                  "idp/RegistryService.RegisterApplication"
                ],
                "tags": [
                  "registry"
                ]
              }
            },
            {
              "name": "GetApplication",
              "scope": "idp/RegistryService.GetApplication",
              "operationId": "getApplication",
              "http": {
                "method": "GET",
                "path": "/platform/applications/v1/applications/{applicationId}",
                "pathParams": [
                  "applicationId"
                ]
              },
              "route": {
                "namespace": "platform",
                "apiName": "gateway",
                "version": "v1",
                "audience": "idp",
                "method": "GET",
                "path": "/platform/applications/v1/applications/{applicationId}",
                "operationId": "getApplication",
                "summary": "RegistryService.GetApplication",
                "auth": "gateway-jwt",
                "identityContext": "none",
                "scopes": [
                  "idp/RegistryService.GetApplication"
                ],
                "tags": [
                  "registry"
                ]
              }
            },
            {
              "name": "DeleteApplication",
              "scope": "idp/RegistryService.DeleteApplication",
              "operationId": "deleteApplication",
              "http": {
                "method": "DELETE",
                "path": "/platform/applications/v1/applications/{applicationId}",
                "pathParams": [
                  "applicationId"
                ]
              },
              "route": {
                "namespace": "platform",
                "apiName": "gateway",
                "version": "v1",
                "audience": "idp",
                "method": "DELETE",
                "path": "/platform/applications/v1/applications/{applicationId}",
                "operationId": "deleteApplication",
                "summary": "RegistryService.DeleteApplication",
                "auth": "gateway-jwt",
                "identityContext": "none",
                "scopes": [
                  "idp/RegistryService.DeleteApplication"
                ],
                "tags": [
                  "registry"
                ]
              }
            },
            {
              "name": "RegisterClient",
              "scope": "idp/RegistryService.RegisterClient",
              "operationId": "registerClient",
              "http": {
                "method": "POST",
                "path": "/platform/applications/v1/applications/{applicationId}/service/clients",
                "pathParams": [
                  "applicationId"
                ]
              },
              "route": {
                "namespace": "platform",
                "apiName": "gateway",
                "version": "v1",
                "audience": "idp",
                "method": "POST",
                "path": "/platform/applications/v1/applications/{applicationId}/service/clients",
                "operationId": "registerClient",
                "summary": "RegistryService.RegisterClient",
                "auth": "gateway-jwt",
                "identityContext": "none",
                "scopes": [
                  "idp/RegistryService.RegisterClient"
                ],
                "tags": [
                  "registry"
                ]
              }
            }
          ]
        },
        {
          "name": "ClientIdentityService",
          "methods": [
            {
              "name": "RegisterClientIdentity",
              "scope": "idp/ClientIdentityService.RegisterClientIdentity",
              "operationId": "registerClientIdentity",
              "http": {
                "method": "POST",
                "path": "/platform/gateway/v1/client/identities"
              },
              "route": {
                "namespace": "platform",
                "apiName": "gateway",
                "version": "v1",
                "audience": "idp",
                "method": "POST",
                "path": "/platform/gateway/v1/client/identities",
                "operationId": "registerClientIdentity",
                "summary": "ClientIdentityService.RegisterClientIdentity",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "idp/ClientIdentityService.RegisterClientIdentity"
                ],
                "tags": [
                  "clientidentity"
                ]
              }
            },
            {
              "name": "ListClientIdentities",
              "scope": "idp/ClientIdentityService.ListClientIdentities",
              "operationId": "listClientIdentities",
              "http": {
                "method": "GET",
                "path": "/platform/gateway/v1/client/identities"
              },
              "route": {
                "namespace": "platform",
                "apiName": "gateway",
                "version": "v1",
                "audience": "idp",
                "method": "GET",
                "path": "/platform/gateway/v1/client/identities",
                "operationId": "listClientIdentities",
                "summary": "ClientIdentityService.ListClientIdentities",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "idp/ClientIdentityService.ListClientIdentities"
                ],
                "tags": [
                  "clientidentity"
                ]
              }
            }
          ]
        },
        {
          "name": "TraceService",
          "methods": [
            {
              "name": "ListTraces",
              "scope": "idp/TraceService.ListTraces",
              "operationId": "listTraces",
              "http": {
                "method": "GET",
                "path": "/platform/traces/v1/traces"
              },
              "route": {
                "namespace": "platform",
                "apiName": "gateway",
                "version": "v1",
                "audience": "idp",
                "method": "GET",
                "path": "/platform/traces/v1/traces",
                "operationId": "listTraces",
                "summary": "TraceService.ListTraces",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "idp/TraceService.ListTraces"
                ],
                "tags": [
                  "trace"
                ]
              }
            },
            {
              "name": "GetTrace",
              "scope": "idp/TraceService.GetTrace",
              "operationId": "getTrace",
              "http": {
                "method": "GET",
                "path": "/platform/traces/v1/traces/{traceId}",
                "pathParams": [
                  "traceId"
                ]
              },
              "route": {
                "namespace": "platform",
                "apiName": "gateway",
                "version": "v1",
                "audience": "idp",
                "method": "GET",
                "path": "/platform/traces/v1/traces/{traceId}",
                "operationId": "getTrace",
                "summary": "TraceService.GetTrace",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "idp/TraceService.GetTrace"
                ],
                "tags": [
                  "trace"
                ]
              }
            },
            {
              "name": "StreamTraces",
              "scope": "idp/TraceService.StreamTraces",
              "operationId": "streamTraces",
              "http": {
                "method": "POST",
                "path": "/platform/traces/v1/traces/stream",
                "stream": "ndjson"
              },
              "route": {
                "namespace": "platform",
                "apiName": "gateway",
                "version": "v1",
                "audience": "idp",
                "method": "POST",
                "path": "/platform/traces/v1/traces/stream",
                "operationId": "streamTraces",
                "summary": "TraceService.StreamTraces",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "idp/TraceService.StreamTraces"
                ],
                "tags": [
                  "trace"
                ]
              }
            }
          ]
        }
      ]
    },
    "ragbot": {
      "audience": "ragbot",
      "apiName": "ragbot",
      "routePrefix": "/platform/ragbot/v1/",
      "resources": [
        {
          "name": "ConfigService",
          "methods": [
            {
              "name": "ListConfig",
              "scope": "ragbot/ConfigService.ListConfig",
              "operationId": "listConfig",
              "http": {
                "method": "GET",
                "path": "/platform/ragbot/v1/configurations"
              },
              "route": {
                "namespace": "platform",
                "apiName": "ragbot",
                "version": "v1",
                "audience": "ragbot",
                "method": "GET",
                "path": "/platform/ragbot/v1/configurations",
                "operationId": "listConfig",
                "summary": "ConfigService.ListConfig",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "ragbot/ConfigService.ListConfig"
                ],
                "tags": [
                  "config"
                ]
              }
            },
            {
              "name": "GetConfig",
              "scope": "ragbot/ConfigService.GetConfig",
              "operationId": "getConfig",
              "http": {
                "method": "GET",
                "path": "/platform/ragbot/v1/configurations/{key}",
                "pathParams": [
                  "key"
                ]
              },
              "route": {
                "namespace": "platform",
                "apiName": "ragbot",
                "version": "v1",
                "audience": "ragbot",
                "method": "GET",
                "path": "/platform/ragbot/v1/configurations/{key}",
                "operationId": "getConfig",
                "summary": "ConfigService.GetConfig",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "ragbot/ConfigService.GetConfig"
                ],
                "tags": [
                  "config"
                ]
              }
            },
            {
              "name": "UpdateConfig",
              "scope": "ragbot/ConfigService.UpdateConfig",
              "operationId": "updateConfig",
              "http": {
                "method": "PATCH",
                "path": "/platform/ragbot/v1/configurations/{key}",
                "pathParams": [
                  "key"
                ]
              },
              "route": {
                "namespace": "platform",
                "apiName": "ragbot",
                "version": "v1",
                "audience": "ragbot",
                "method": "PATCH",
                "path": "/platform/ragbot/v1/configurations/{key}",
                "operationId": "updateConfig",
                "summary": "ConfigService.UpdateConfig",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "ragbot/ConfigService.UpdateConfig"
                ],
                "tags": [
                  "config"
                ]
              }
            },
            {
              "name": "ResetConfig",
              "scope": "ragbot/ConfigService.ResetConfig",
              "operationId": "resetConfig",
              "http": {
                "method": "DELETE",
                "path": "/platform/ragbot/v1/configurations/{key}",
                "pathParams": [
                  "key"
                ]
              },
              "route": {
                "namespace": "platform",
                "apiName": "ragbot",
                "version": "v1",
                "audience": "ragbot",
                "method": "DELETE",
                "path": "/platform/ragbot/v1/configurations/{key}",
                "operationId": "resetConfig",
                "summary": "ConfigService.ResetConfig",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "ragbot/ConfigService.ResetConfig"
                ],
                "tags": [
                  "config"
                ]
              }
            }
          ]
        },
        {
          "name": "InteractionService",
          "methods": [
            {
              "name": "ListInteractions",
              "scope": "ragbot/InteractionService.ListInteractions",
              "operationId": "listInteractions",
              "http": {
                "method": "GET",
                "path": "/platform/ragbot/v1/interactions"
              },
              "route": {
                "namespace": "platform",
                "apiName": "ragbot",
                "version": "v1",
                "audience": "ragbot",
                "method": "GET",
                "path": "/platform/ragbot/v1/interactions",
                "operationId": "listInteractions",
                "summary": "InteractionService.ListInteractions",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "ragbot/InteractionService.ListInteractions"
                ],
                "tags": [
                  "interaction"
                ]
              }
            }
          ]
        },
        {
          "name": "ChatService",
          "methods": [
            {
              "name": "Chat",
              "scope": "ragbot/ChatService.Chat",
              "operationId": "chat",
              "http": {
                "method": "POST",
                "path": "/platform/ragbot/v1/chat/completions"
              },
              "route": {
                "namespace": "platform",
                "apiName": "ragbot",
                "version": "v1",
                "audience": "ragbot",
                "method": "POST",
                "path": "/platform/ragbot/v1/chat/completions",
                "operationId": "chat",
                "summary": "ChatService.Chat",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "ragbot/ChatService.Chat"
                ],
                "tags": [
                  "chat"
                ]
              }
            },
            {
              "name": "StreamChat",
              "scope": "ragbot/ChatService.StreamChat",
              "operationId": "streamChat",
              "http": {
                "method": "POST",
                "path": "/platform/ragbot/v1/chat/completions/stream",
                "stream": "ndjson"
              },
              "route": {
                "namespace": "platform",
                "apiName": "ragbot",
                "version": "v1",
                "audience": "ragbot",
                "method": "POST",
                "path": "/platform/ragbot/v1/chat/completions/stream",
                "operationId": "streamChat",
                "summary": "ChatService.StreamChat",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "ragbot/ChatService.StreamChat"
                ],
                "tags": [
                  "chat"
                ]
              }
            }
          ]
        },
        {
          "name": "LeaderboardService",
          "methods": [
            {
              "name": "ListTotals",
              "scope": "ragbot/LeaderboardService.ListTotals",
              "operationId": "listTotals",
              "http": {
                "method": "GET",
                "path": "/platform/ragbot/v1/leaderboard/totals"
              },
              "route": {
                "namespace": "platform",
                "apiName": "ragbot",
                "version": "v1",
                "audience": "ragbot",
                "method": "GET",
                "path": "/platform/ragbot/v1/leaderboard/totals",
                "operationId": "listTotals",
                "summary": "LeaderboardService.ListTotals",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "ragbot/LeaderboardService.ListTotals"
                ],
                "tags": [
                  "leaderboard"
                ]
              }
            }
          ]
        },
        {
          "name": "DatabaseService",
          "methods": [
            {
              "name": "Query",
              "scope": "ragbot/DatabaseService.Query",
              "operationId": "query",
              "http": {
                "method": "POST",
                "path": "/platform/ragbot/v1/database/queries"
              },
              "route": {
                "namespace": "platform",
                "apiName": "ragbot",
                "version": "v1",
                "audience": "ragbot",
                "method": "POST",
                "path": "/platform/ragbot/v1/database/queries",
                "operationId": "query",
                "summary": "DatabaseService.Query",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "ragbot/DatabaseService.Query"
                ],
                "tags": [
                  "database"
                ]
              }
            }
          ]
        },
        {
          "name": "GatewayControlService",
          "methods": [
            {
              "name": "GetHealth",
              "scope": "ragbot/GatewayControlService.GetHealth",
              "operationId": "getHealth",
              "http": {
                "method": "GET",
                "path": "/platform/ragbot/v1/gateway/health"
              },
              "route": {
                "namespace": "platform",
                "apiName": "ragbot",
                "version": "v1",
                "audience": "ragbot",
                "method": "GET",
                "path": "/platform/ragbot/v1/gateway/health",
                "operationId": "getHealth",
                "summary": "GatewayControlService.GetHealth",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "ragbot/GatewayControlService.GetHealth"
                ],
                "tags": [
                  "gatewaycontrol"
                ]
              }
            },
            {
              "name": "StartGateway",
              "scope": "ragbot/GatewayControlService.StartGateway",
              "operationId": "startGateway",
              "http": {
                "method": "POST",
                "path": "/platform/ragbot/v1/gateway/starts"
              },
              "route": {
                "namespace": "platform",
                "apiName": "ragbot",
                "version": "v1",
                "audience": "ragbot",
                "method": "POST",
                "path": "/platform/ragbot/v1/gateway/starts",
                "operationId": "startGateway",
                "summary": "GatewayControlService.StartGateway",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "ragbot/GatewayControlService.StartGateway"
                ],
                "tags": [
                  "gatewaycontrol"
                ]
              }
            }
          ]
        }
      ]
    },
    "aigateway": {
      "audience": "aigateway",
      "apiName": "aigateway",
      "routePrefix": "/platform/aigateway/v1/",
      "resources": [
        {
          "name": "ChatService",
          "methods": [
            {
              "name": "Complete",
              "scope": "aigateway/ChatService.Complete",
              "operationId": "complete",
              "http": {
                "method": "POST",
                "path": "/platform/aigateway/v1/chat/completions"
              },
              "route": {
                "namespace": "platform",
                "apiName": "aigateway",
                "version": "v1",
                "audience": "aigateway",
                "method": "POST",
                "path": "/platform/aigateway/v1/chat/completions",
                "operationId": "complete",
                "summary": "ChatService.Complete",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "aigateway/ChatService.Complete"
                ],
                "tags": [
                  "chat"
                ]
              }
            },
            {
              "name": "StreamComplete",
              "scope": "aigateway/ChatService.StreamComplete",
              "operationId": "streamComplete",
              "http": {
                "method": "POST",
                "path": "/platform/aigateway/v1/chat/completions/stream",
                "stream": "ndjson"
              },
              "route": {
                "namespace": "platform",
                "apiName": "aigateway",
                "version": "v1",
                "audience": "aigateway",
                "method": "POST",
                "path": "/platform/aigateway/v1/chat/completions/stream",
                "operationId": "streamComplete",
                "summary": "ChatService.StreamComplete",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "aigateway/ChatService.StreamComplete"
                ],
                "tags": [
                  "chat"
                ]
              }
            },
            {
              "name": "ListModels",
              "scope": "aigateway/ChatService.ListModels",
              "operationId": "listModels",
              "http": {
                "method": "GET",
                "path": "/platform/aigateway/v1/models"
              },
              "route": {
                "namespace": "platform",
                "apiName": "aigateway",
                "version": "v1",
                "audience": "aigateway",
                "method": "GET",
                "path": "/platform/aigateway/v1/models",
                "operationId": "listModels",
                "summary": "ChatService.ListModels",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "aigateway/ChatService.ListModels"
                ],
                "tags": [
                  "chat"
                ]
              }
            }
          ]
        }
      ]
    },
    "deploy": {
      "audience": "deploy",
      "apiName": "deploy",
      "routePrefix": "/platform/deploy/v1/",
      "resources": [
        {
          "name": "DeployService",
          "methods": [
            {
              "name": "ListWorkers",
              "scope": "deploy/DeployService.ListWorkers",
              "operationId": "listWorkers",
              "http": {
                "method": "GET",
                "path": "/platform/deploy/v1/workers"
              },
              "route": {
                "namespace": "platform",
                "apiName": "deploy",
                "version": "v1",
                "audience": "deploy",
                "method": "GET",
                "path": "/platform/deploy/v1/workers",
                "operationId": "listWorkers",
                "summary": "DeployService.ListWorkers",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "deploy/DeployService.ListWorkers"
                ],
                "tags": [
                  "deploy"
                ]
              }
            },
            {
              "name": "DeployWorker",
              "scope": "deploy/DeployService.DeployWorker",
              "operationId": "deployWorker",
              "http": {
                "method": "POST",
                "path": "/platform/deploy/v1/worker/deployments"
              },
              "route": {
                "namespace": "platform",
                "apiName": "deploy",
                "version": "v1",
                "audience": "deploy",
                "method": "POST",
                "path": "/platform/deploy/v1/worker/deployments",
                "operationId": "deployWorker",
                "summary": "DeployService.DeployWorker",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "deploy/DeployService.DeployWorker"
                ],
                "tags": [
                  "deploy"
                ]
              }
            }
          ]
        }
      ]
    },
    "cloudflare": {
      "audience": "cloudflare",
      "apiName": "cloudflare",
      "routePrefix": "/platform/cloudflare/v1/",
      "resources": [
        {
          "name": "DeviceService",
          "methods": [
            {
              "name": "ListDevices",
              "scope": "cloudflare/DeviceService.ListDevices",
              "operationId": "listDevices",
              "http": {
                "method": "GET",
                "path": "/platform/cloudflare/v1/devices"
              },
              "route": {
                "namespace": "platform",
                "apiName": "cloudflare",
                "version": "v1",
                "audience": "cloudflare",
                "method": "GET",
                "path": "/platform/cloudflare/v1/devices",
                "operationId": "listDevices",
                "summary": "DeviceService.ListDevices",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "cloudflare/DeviceService.ListDevices"
                ],
                "tags": [
                  "device"
                ]
              }
            },
            {
              "name": "GetDevice",
              "scope": "cloudflare/DeviceService.GetDevice",
              "operationId": "getDevice",
              "http": {
                "method": "GET",
                "path": "/platform/cloudflare/v1/devices/{deviceId}",
                "pathParams": [
                  "deviceId"
                ]
              },
              "route": {
                "namespace": "platform",
                "apiName": "cloudflare",
                "version": "v1",
                "audience": "cloudflare",
                "method": "GET",
                "path": "/platform/cloudflare/v1/devices/{deviceId}",
                "operationId": "getDevice",
                "summary": "DeviceService.GetDevice",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "cloudflare/DeviceService.GetDevice"
                ],
                "tags": [
                  "device"
                ]
              }
            },
            {
              "name": "DeleteDevice",
              "scope": "cloudflare/DeviceService.DeleteDevice",
              "operationId": "deleteDevice",
              "http": {
                "method": "DELETE",
                "path": "/platform/cloudflare/v1/devices/{deviceId}",
                "pathParams": [
                  "deviceId"
                ]
              },
              "route": {
                "namespace": "platform",
                "apiName": "cloudflare",
                "version": "v1",
                "audience": "cloudflare",
                "method": "DELETE",
                "path": "/platform/cloudflare/v1/devices/{deviceId}",
                "operationId": "deleteDevice",
                "summary": "DeviceService.DeleteDevice",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "cloudflare/DeviceService.DeleteDevice"
                ],
                "tags": [
                  "device"
                ]
              }
            },
            {
              "name": "RevokeDevice",
              "scope": "cloudflare/DeviceService.RevokeDevice",
              "operationId": "revokeDevice",
              "http": {
                "method": "POST",
                "path": "/platform/cloudflare/v1/devices/{deviceId}/revocations",
                "pathParams": [
                  "deviceId"
                ]
              },
              "route": {
                "namespace": "platform",
                "apiName": "cloudflare",
                "version": "v1",
                "audience": "cloudflare",
                "method": "POST",
                "path": "/platform/cloudflare/v1/devices/{deviceId}/revocations",
                "operationId": "revokeDevice",
                "summary": "DeviceService.RevokeDevice",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "cloudflare/DeviceService.RevokeDevice"
                ],
                "tags": [
                  "device"
                ]
              }
            }
          ]
        },
        {
          "name": "WorkerService",
          "methods": [
            {
              "name": "DeployWorker",
              "scope": "cloudflare/WorkerService.DeployWorker",
              "operationId": "deployWorker",
              "http": {
                "method": "POST",
                "path": "/platform/cloudflare/v1/worker/deployments"
              },
              "route": {
                "namespace": "platform",
                "apiName": "cloudflare",
                "version": "v1",
                "audience": "cloudflare",
                "method": "POST",
                "path": "/platform/cloudflare/v1/worker/deployments",
                "operationId": "deployWorker",
                "summary": "WorkerService.DeployWorker",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "cloudflare/WorkerService.DeployWorker"
                ],
                "tags": [
                  "worker"
                ]
              }
            },
            {
              "name": "ListWorkers",
              "scope": "cloudflare/WorkerService.ListWorkers",
              "operationId": "listWorkers",
              "http": {
                "method": "GET",
                "path": "/platform/cloudflare/v1/workers"
              },
              "route": {
                "namespace": "platform",
                "apiName": "cloudflare",
                "version": "v1",
                "audience": "cloudflare",
                "method": "GET",
                "path": "/platform/cloudflare/v1/workers",
                "operationId": "listWorkers",
                "summary": "WorkerService.ListWorkers",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "cloudflare/WorkerService.ListWorkers"
                ],
                "tags": [
                  "worker"
                ]
              }
            }
          ]
        }
      ]
    },
    "discovery": {
      "audience": "discovery",
      "apiName": "discovery",
      "routePrefix": "/platform/discovery/v1/",
      "resources": [
        {
          "name": "DiscoveryService",
          "methods": [
            {
              "name": "Query",
              "scope": "discovery/DiscoveryService.Query",
              "operationId": "query",
              "http": {
                "method": "POST",
                "path": "/platform/discovery/v1/graphql/queries"
              },
              "route": {
                "namespace": "platform",
                "apiName": "discovery",
                "version": "v1",
                "audience": "discovery",
                "method": "POST",
                "path": "/platform/discovery/v1/graphql/queries",
                "operationId": "query",
                "summary": "DiscoveryService.Query",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "discovery/DiscoveryService.Query"
                ],
                "tags": [
                  "discovery"
                ]
              }
            },
            {
              "name": "Sync",
              "scope": "discovery/DiscoveryService.Sync",
              "operationId": "sync",
              "http": {
                "method": "POST",
                "path": "/platform/discovery/v1/synchronisations"
              },
              "route": {
                "namespace": "platform",
                "apiName": "discovery",
                "version": "v1",
                "audience": "discovery",
                "method": "POST",
                "path": "/platform/discovery/v1/synchronisations",
                "operationId": "sync",
                "summary": "DiscoveryService.Sync",
                "auth": "gateway-jwt",
                "identityContext": "dpop",
                "scopes": [
                  "discovery/DiscoveryService.Sync"
                ],
                "tags": [
                  "discovery"
                ]
              }
            }
          ]
        }
      ]
    }
  }
} as unknown as PlatformCatalog;
