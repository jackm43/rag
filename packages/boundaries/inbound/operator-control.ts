import { guardDenial, type InboundGuard } from "./guard";
import { timingSafeEqual } from "./timing-safe-equal";

const encoder = new TextEncoder();

export const secretsMatch = (actual: string, expected: string) => {
  const actualBytes = encoder.encode(actual);
  const expectedBytes = encoder.encode(expected);
  return timingSafeEqual(actualBytes, expectedBytes);
};

export const bearerTokenMatches = (authorization: string, expectedToken: string) => {
  const separatorIndex = authorization.indexOf(" ");
  if (separatorIndex === -1) {
    return false;
  }

  const scheme = authorization.slice(0, separatorIndex);
  if (scheme.toLowerCase() !== "bearer") {
    return false;
  }

  return secretsMatch(authorization.slice(separatorIndex + 1), expectedToken);
};

export type OperatorPrincipal = {
  principal: "operator";
};

// Bearer auth with the dedicated GATEWAY_CONTROL_TOKEN secret for the
// /gateway/* control routes. Fails closed (401) when the secret is not
// configured, and never accepts the Discord bot token.
export const operatorControlGuard: InboundGuard<OperatorPrincipal> = {
  identity: "gateway-control",
  trustZone: "ingress-operator",
  verify: async (request, env) => {
    const unauthorized = () => new Response("Unauthorized", { status: 401 });

    const controlToken = env.GATEWAY_CONTROL_TOKEN;
    if (!controlToken) {
      return guardDenial(operatorControlGuard, "control_token_unconfigured", unauthorized());
    }

    const authorization = request.headers.get("authorization");
    if (authorization === null || !bearerTokenMatches(authorization, controlToken)) {
      return guardDenial(operatorControlGuard, "invalid_bearer_token", unauthorized());
    }

    return { ok: true, grant: { principal: "operator" } };
  },
};
