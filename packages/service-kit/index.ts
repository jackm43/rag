// Shared identity vocabulary: the machine-principal names, trust zones, and the
// request-context shapes. The signing/transport implementation (client, server,
// identity tokens, Cedar authorization, registry placement) has been removed —
// worker-to-worker calls are now plain, capability-gated service-binding RPC.
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
export type { RequestContext, ServiceRequest, VerifiedRequestContext } from "./context";
export type { ServiceManifest } from "./manifest";
