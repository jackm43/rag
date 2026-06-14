import { createWebBffWorker } from "@platy/sdk";

export default createWebBffWorker({
  app: "ragbot",
  targets: [
    {
      audience: "ragbot",
      binding: "RAGBOT",
      endpoint: "RAGBOT_ENDPOINT",
      prefixes: [
        "/platform/ragbot/v1/",
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
      ],
    },
    {
      audience: "aigateway",
      binding: "AIGATEWAY",
      endpoint: "AIGATEWAY_ENDPOINT",
      prefixes: [
        "/platform/aigateway/v1/",
      ],
      scopes: [
        "aigateway/ChatService.Complete",
        "aigateway/ChatService.StreamComplete",
      ],
    },
  ],
});
