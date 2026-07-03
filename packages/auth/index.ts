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
export type { RequestContext, ServiceRequest } from "./context";
export {
  createServiceClient,
  serviceClients,
  type HopSession,
  type ServiceCall,
  type ServiceClient,
  type ServiceClientConfig,
  type ServiceClients,
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
export type { ServiceManifest } from "./manifest";
