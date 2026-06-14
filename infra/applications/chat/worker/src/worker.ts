import { idp } from "../../../idp/service";
import { createWebBffWorker } from "@platy/sdk";

export default createWebBffWorker({
  app: "chat",
  registerClient: idp.clientIdentityServiceClient,
  targets: [
    {
      audience: "aigateway",
      binding: "AIGATEWAY",
      endpoint: "AIGATEWAY_ENDPOINT",
      prefixes: [
        "/platform/aigateway/v1/",
      ],
    },
    {
      audience: "ragbot",
      binding: "RAGBOT",
      endpoint: "RAGBOT_ENDPOINT",
      prefixes: [
        "/platform/ragbot/v1/",
      ],
      scopes: [
        "ragbot/LeaderboardService.ListTotals",
        "ragbot/ConfigService.ListConfig",
        "ragbot/InteractionService.ListInteractions",
        "ragbot/GatewayControlService.GetHealth",
      ],
    },
    {
      audience: "idp",
      binding: "AUTH_GATEWAY",
      endpoint: "AUTH_GATEWAY_URL",
      prefixes: [
        "/platform/applications/v1/",
        "/platform/gateway/v1/",
        "/platform/traces/v1/",
      ],
      scopes: [
        "idp/ClientIdentityService.RegisterClientIdentity",
        "idp/TraceService.ListTraces",
        "idp/TraceService.GetTrace",
        "idp/TraceService.StreamTraces",
        "idp/DiscoveryService.Discover",
      ],
    },
  ],
});
