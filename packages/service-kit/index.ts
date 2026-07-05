// Shared identity vocabulary: the machine-principal names and the request-context
// shapes. The signing/transport implementation (client, server, identity tokens,
// Cedar authorization, registry placement) has been removed — worker-to-worker
// calls are now plain, capability-gated service-binding RPC.
export {
  isMachinePrincipal,
  SYSTEM_SUBJECT,
  type MachinePrincipal,
  type Subject,
} from "./principal";
export type { RequestContext, VerifiedRequestContext } from "./context";
