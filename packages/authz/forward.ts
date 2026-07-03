import type { EntityJson } from "@cedar-policy/cedar-wasm/web";
import { authorize, type AuthorizationRequest, type Decision } from "./authorize";

// Forwarding authorizer: authorization is structurally on the request path
// rather than a boolean a caller may ignore. Either the request is authorized
// and `forward` runs, or the caller's `deny` hook fires (logging the denial in
// its own context shape) and the request exits with null.
export const authorizeAndForward = async <T>(
  request: AuthorizationRequest,
  options: {
    entities?: EntityJson[];
    deny: (decision: Decision) => void;
  },
  forward: () => T | Promise<T>,
): Promise<T | null> => {
  const decision = authorize(request, options.entities ?? []);
  if (!decision.allowed) {
    options.deny(decision);
    return null;
  }
  return forward();
};
