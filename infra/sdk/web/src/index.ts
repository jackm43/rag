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
  createPlatformWebClient,
  type PlatformWebClientOptions,
  type PlatformWebClients,
} from "./platform-client";
export type { PlatformWebClientOptions as BrowserPlatformClientOptions, PlatformWebClients as BrowserPlatformClients } from "./platform-client";
export type {
  ChatStreamChunk,
  ConfigEntry,
  ModelInfo,
  RagbotChatStreamChunk,
  RagInteraction,
  TraceSpan,
  TraceStreamMessage,
  TraceSummary,
} from "./platform-types";
export {
  CLIENT_INSTANCE_HEADER,
  CLIENT_TOKEN_HEADER,
  registerChatInstance,
  type ChatInstance,
  type ClientIdentityDocument,
} from "./instance";
