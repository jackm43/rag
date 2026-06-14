import { OAuthError, OAuthErrorCode } from "./oauth-error";
import { delegationFor, getApplicationByAudience, verifyServiceClient } from "./registry";
import { signToken } from "./keys";
import type { Env } from "./types";

const SERVICE_BINDING_LIFETIME_SECONDS = 60;

const issuer = (env: Env): string => env.GATEWAY_ISSUER.replace(/\/$/, "");

export type ServiceBindingMintInput = {
  caller: string;
  target: string;
  method: string;
  path: string;
  bodyDigest: string;
};

export const mintServiceBindingToken = async (
  env: Env,
  clientId: string,
  clientSecret: string,
  input: ServiceBindingMintInput,
): Promise<{ token: string; expiresIn: number }> => {
  const callerApplication = await verifyServiceClient(env, clientId, clientSecret);
  if (!callerApplication || callerApplication !== input.caller) {
    throw new OAuthError("invalid service credential", OAuthErrorCode.Unauthenticated);
  }
  const targetApplication = await getApplicationByAudience(env, input.target);
  if (!targetApplication) {
    throw new OAuthError(`unknown target ${input.target}`, OAuthErrorCode.NotFound);
  }
  const delegation = await delegationFor(env, callerApplication, input.target);
  if (!delegation) {
    throw new OAuthError(
      `application ${callerApplication} has no delegation to ${input.target}`,
      OAuthErrorCode.PermissionDenied,
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const token = await signToken(env, {
    iss: issuer(env),
    sub: clientId,
    aud: input.target,
    kind: "service-binding",
    caller: callerApplication,
    bind_m: input.method.toUpperCase(),
    bind_p: input.path,
    bind_d: input.bodyDigest,
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + SERVICE_BINDING_LIFETIME_SECONDS,
  });
  return { token, expiresIn: SERVICE_BINDING_LIFETIME_SECONDS };
};
