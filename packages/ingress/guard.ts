import { logger } from "@rag/logger";
import type { IngressEnv as Env } from "./env";

// Inbound boundary: every request entering a platform worker from the public
// internet crosses a named guard. Denials log the same
// context shape as the service boundary and the outbound boundary client
// ({identity, zone, transport, outcome, reason}), so a policy engine can
// evaluate at exactly these choke points.
export type GuardResult<T> =
  | { ok: true; grant: T }
  | { ok: false; reason: string; response: Response };

export type InboundGuard<T> = {
  identity: string;
  verify: (request: Request, env: Env) => Promise<GuardResult<T>>;
};

export const guardDenial = <T>(
  guard: Pick<InboundGuard<T>, "identity">,
  reason: string,
  response: Response,
): GuardResult<T> => {
  logger.warn("ingress_denied", {
    identity: guard.identity,
    zone: "platform",
    transport: "http",
    outcome: "denied",
    reason,
  });
  return { ok: false, reason, response };
};
