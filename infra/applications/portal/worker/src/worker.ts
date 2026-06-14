import { idp } from "../../../idp/service";
import { createWebBffWorker } from "@platy/sdk";

export default createWebBffWorker({
  app: "portal",
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
        "ragbot/InteractionService.ListInteractions",
        "ragbot/ConfigService.ListConfig",
        "ragbot/ConfigService.GetConfig",
        "ragbot/ConfigService.UpdateConfig",
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
      ],
    },
  ],
});
