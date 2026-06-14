import { idp } from "../../../idp/service";
import { createWebBffWorker } from "@platy/sdk";

export default createWebBffWorker({
  app: "console",
  registerClient: idp.clientIdentityServiceClient,
  targets: [
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
        "idp/RegistryService.RegisterApplication",
        "idp/RegistryService.GetApplication",
        "idp/RegistryService.ListApplications",
        "idp/RegistryService.DeleteApplication",
        "idp/TraceService.ListTraces",
        "idp/TraceService.GetTrace",
        "idp/TraceService.StreamTraces",
        "idp/DiscoveryService.Discover",
        "idp/ClientIdentityService.RegisterClientIdentity",
      ],
    },
    {
      audience: "deploy",
      binding: "DEPLOY",
      endpoint: "DEPLOY_ENDPOINT",
      prefixes: [
        "/platform/deploy/v1/",
      ],
      scopes: [
        "deploy/DeployService.ListWorkers",
        "deploy/DeployService.DeployWorker",
      ],
    },
    {
      audience: "discovery",
      binding: "DISCOVERY",
      endpoint: "DISCOVERY_ENDPOINT",
      prefixes: [
        "/platform/discovery/v1/",
      ],
      scopes: [
        "discovery/DiscoveryService.Query",
        "discovery/DiscoveryService.Sync",
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
        "ragbot/ConfigService.ListConfig",
        "ragbot/ConfigService.GetConfig",
        "ragbot/ConfigService.UpdateConfig",
        "ragbot/ConfigService.ResetConfig",
        "ragbot/GatewayControlService.GetHealth",
      ],
    },
  ],
});
