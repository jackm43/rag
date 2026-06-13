export {
  BrowserAuth,
  NeedsLoginError,
  type BootstrapOptions,
  type BootstrapResult,
  type SessionState,
  type EnsureResult,
  type DiscoveryApplication,
  type DiscoveryConfig,
  type BrowserAuthOptions,
} from "./browser-auth";
export {
  gatewayClient,
  gatewayTransport,
  webClient,
  webTransport,
  type WebClientOptions,
} from "./transport";
export {
  CLIENT_INSTANCE_HEADER,
  CLIENT_TOKEN_HEADER,
  registerChatInstance,
  type ChatInstance,
  type ClientIdentityDocument,
} from "./instance";
