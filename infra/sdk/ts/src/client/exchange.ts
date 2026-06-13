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
  const params = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: request.subjectToken,
    subject_token_type: request.subjectTokenType ?? TOKEN_TYPE_ACCESS_TOKEN,
    audience: request.audience,
    requested_token_type: TOKEN_TYPE_JWT,
  });
  if (request.scopes?.length) {
    params.set("scope", request.scopes.join(" "));
  }
  if (request.actorToken) {
    params.set("actor_token", request.actorToken);
    params.set("actor_token_type", request.actorTokenType ?? TOKEN_TYPE_SERVICE_CREDENTIAL);
  }
  if (request.impersonationToken) {
    params.set("impersonation_token", request.impersonationToken);
    params.set("impersonation_token_type", request.impersonationTokenType ?? TOKEN_TYPE_ACCESS_TOKEN);
  }
  const response = await (transport ?? fetch)(
    `${gatewayUrl.replace(/\/$/, "")}/oauth/token`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        // Token exchanges are hops in the request flow: keep them on the
        // caller's trace so the full chain renders as one trace.
        ...traceHeaders(),
      },
      body: params.toString(),
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
    access_token?: string;
    expires_in?: number | string;
    scope?: string;
  };
  if (!body.access_token) {
    return null;
  }
  const scopes = (body.scope ?? "")
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  identityExchanged({
    audience: request.audience,
    subject_token_type: subjectTokenType,
    ...(actorTokenType ? { actor_token_type: actorTokenType } : {}),
    ...(actorClientId ? { act: actorClientId } : {}),
    ...(request.impersonationToken ? { impersonation: true } : {}),
    scopes,
  });
  return {
    accessToken: body.access_token,
    expiresIn: Number(body.expires_in ?? 0),
    scopes,
  };
};
