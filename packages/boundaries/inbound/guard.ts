import { logger } from "../../logger";
import type { Env } from "../../contracts/types";

// Inbound trust boundary: every request entering a worker crosses a named
// guard carrying {identity, trustZone} — the same context shape the outbound
// boundary client logs — so a future policy engine (Cedar) can evaluate at
// exactly these choke points.
export type InboundTrustZone = "ingress-discord" | "ingress-operator";

export type GuardResult<T> =
  | { ok: true; grant: T }
  | { ok: false; reason: string; response: Response };

export type InboundGuard<T> = {
  identity: string;
  trustZone: InboundTrustZone;
  verify: (request: Request, env: Env) => Promise<GuardResult<T>>;
};

export const guardDenial = <T>(
  guard: Pick<InboundGuard<T>, "identity" | "trustZone">,
  reason: string,
  response: Response,
): GuardResult<T> => {
  logger.warn("ingress_denied", {
    identity: guard.identity,
    trustZone: guard.trustZone,
    outcome: "denied",
    reason,
  });
  return { ok: false, reason, response };
};
