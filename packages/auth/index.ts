// Centralised auth service client library. Workers verify/authenticate at
// ingress, construct a request, and forward it through a client built here;
// zones, credentials, token exchange, authorization, and denial logging are
// implemented behind this surface.
export {
  isMachinePrincipal,
  SERVICE_OPERATIONS,
  SERVICE_ZONE,
  SYSTEM_SUBJECT,
  type MachinePrincipal,
  type Subject,
  type Target,
  type Transport,
  type TrustZone,
} from "./principal";
export type { CorrelatedJwtClaims, JwtClaims } from "./claims";
export type { RequestContext, ServiceRequest, VerifiedRequestContext } from "./context";
export {
  bumpRequestIntentVersion,
  createHopIntent,
  type HopIntent,
  type HopIntentInput,
  revokeRequestIntent,
} from "./control-plane";
export {
  createClient,
  createServiceClient,
  createServiceClientFromEnv,
  type ClientConfig,
  type ClientPrepareOptions,
  type ClientServiceCall,
  type ClientTarget,
  type HopSession,
  type EnvServiceClientConfig,
  type ServiceCall,
  type ServiceClient,
  type ServiceClientConfig,
} from "./client";
export {
  createServiceServer,
  type ServiceServer,
  type ServiceServerConfig,
} from "./server";
export { serviceEnvelopeBytes, wrapServiceMessage } from "./message";
export {
  ensureRegistered,
  registryEntities,
  resetRegistryCaches,
} from "./registry";
export { createQueueWorker, type QueueMessageHandler } from "./queue-worker";
export type { ServiceManifest } from "./manifest";
