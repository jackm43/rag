import { logger } from "../logger";
import { traceHeaders } from "../otel";
import { TOKEN_TYPE_ACCESS_TOKEN, TOKEN_TYPE_JWT, TOKEN_TYPE_SERVICE_CREDENTIAL } from "../verify/sts";

export type ExchangeRequest = {
  subjectToken: string;
  subjectTokenType?: string;
  actorToken?: string;
  actorTokenType?: string;
  audience: string;
  scopes?: string[];
  impersonationToken?: string;
  impersonationTokenType?: string;
};

export type ExchangedToken = {
  accessToken: string;
  expiresIn: number;
  scopes: string[];
};

export type ServiceCredential = {
  clientId: string;
  clientSecret: string;
};

export const serviceCredentialFromEnv = (env: {
  SERVICE_CLIENT_ID?: string;
  SERVICE_CLIENT_SECRET?: string;
}): ServiceCredential | null =>
  env.SERVICE_CLIENT_ID && env.SERVICE_CLIENT_SECRET
    ? { clientId: env.SERVICE_CLIENT_ID, clientSecret: env.SERVICE_CLIENT_SECRET }
    : null;

export const chainExchange = (
  gatewayUrl: string,
  callerToken: string,
  credential: ServiceCredential,
  audience: string,
  scopes?: string[],
  transport?: typeof fetch,
): Promise<ExchangedToken | null> =>
  exchangeToken(
    gatewayUrl,
    {
      subjectToken: callerToken,
      subjectTokenType: TOKEN_TYPE_JWT,
      actorToken: `${credential.clientId}:${credential.clientSecret}`,
      actorTokenType: TOKEN_TYPE_SERVICE_CREDENTIAL,
      audience,
      scopes,
    },
    transport,
  );

// transport lets workers route the exchange through a service binding —
// same-account worker-to-worker fetches over public workers.dev URLs are
// blocked by the platform.
export const exchangeToken = async (
  gatewayUrl: string,
  request: ExchangeRequest,
  transport?: typeof fetch,
): Promise<ExchangedToken | null> => {
  const response = await (transport ?? fetch)(
    `${gatewayUrl.replace(/\/$/, "")}/idp.v1.IdentityService/ExchangeToken`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "connect-protocol-version": "1",
        // Token exchanges are hops in the request flow: keep them on the
        // caller's trace so the full chain renders as one trace.
        ...traceHeaders(),
      },
      body: JSON.stringify({
        subjectToken: request.subjectToken,
        subjectTokenType: request.subjectTokenType ?? TOKEN_TYPE_ACCESS_TOKEN,
        actorToken: request.actorToken ?? "",
        actorTokenType: request.actorToken
          ? request.actorTokenType ?? TOKEN_TYPE_SERVICE_CREDENTIAL
          : "",
        audience: request.audience,
        scopes: request.scopes ?? [],
        requestedTokenType: TOKEN_TYPE_JWT,
        impersonationToken: request.impersonationToken ?? "",
        impersonationTokenType: request.impersonationToken
          ? request.impersonationTokenType ?? TOKEN_TYPE_ACCESS_TOKEN
          : "",
      }),
    },
  );
  // Identity-boundary standard: every identity change is logged at the
  // client that makes it (the gateway's server span records the other side).
  // Only the actor's client id is ever logged, never a secret.
  const actorClientId = request.actorToken ? request.actorToken.split(":")[0] : "";
  if (!response.ok) {
    logger.warn("identity_exchange_refused", {
      audience: request.audience,
      subject_type: request.subjectTokenType ?? TOKEN_TYPE_ACCESS_TOKEN,
      actor: actorClientId,
      status: response.status,
    });
    return null;
  }
  const body = (await response.json()) as {
    accessToken?: string;
    expiresIn?: number | string;
    scopes?: string[];
  };
  if (!body.accessToken) {
    return null;
  }
  logger.info("identity_exchanged", {
    audience: request.audience,
    subject_type: request.subjectTokenType ?? TOKEN_TYPE_ACCESS_TOKEN,
    actor: actorClientId,
    scopes: body.scopes ?? [],
  });
  return {
    accessToken: body.accessToken,
    expiresIn: Number(body.expiresIn ?? 0),
    scopes: body.scopes ?? [],
  };
};
