import { actorToken, type ServiceCredential } from "../credential";
import { identityExchanged, identityExchangeRefused } from "../identity";
import { traceHeaders } from "../otel";
import { TOKEN_TYPE_ACCESS_TOKEN, TOKEN_TYPE_JWT, TOKEN_TYPE_SERVICE_CREDENTIAL } from "../verify/sts";

export type { ServiceCredential } from "../credential";
export { serviceCredentialFromEnv } from "../credential";

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
      actorToken: actorToken(credential),
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
  const actorClientId = request.actorToken ? request.actorToken.split(":")[0] : "";
  const subjectTokenType = request.subjectTokenType ?? TOKEN_TYPE_ACCESS_TOKEN;
  const actorTokenType = request.actorToken
    ? request.actorTokenType ?? TOKEN_TYPE_SERVICE_CREDENTIAL
    : undefined;
  if (!response.ok) {
    identityExchangeRefused({
      audience: request.audience,
      subject_token_type: subjectTokenType,
      ...(actorTokenType ? { actor_token_type: actorTokenType } : {}),
      ...(actorClientId ? { act: actorClientId } : {}),
      ...(request.impersonationToken ? { impersonation: true } : {}),
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
  identityExchanged({
    audience: request.audience,
    subject_token_type: subjectTokenType,
    ...(actorTokenType ? { actor_token_type: actorTokenType } : {}),
    ...(actorClientId ? { act: actorClientId } : {}),
    ...(request.impersonationToken ? { impersonation: true } : {}),
    scopes: body.scopes ?? [],
  });
  return {
    accessToken: body.accessToken,
    expiresIn: Number(body.expiresIn ?? 0),
    scopes: body.scopes ?? [],
  };
};
