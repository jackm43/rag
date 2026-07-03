import { logger } from "../../logger";
import type { Env } from "../../contracts/types";

// Inbound trust boundary: every request entering a worker from the untrusted
// zone (the public internet) crosses a named guard. Denials log the same
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
    zone: "untrusted",
    transport: "http",
    outcome: "denied",
    reason,
  });
  return { ok: false, reason, response };
};
