import { Code, ConnectError } from "@connectrpc/connect";

type ExchangeProviderTokenResponse = {
  accessToken?: string;
  expiresIn?: number | string;
  authorizeUrl?: string;
  message?: string;
};

export type ProviderAccessToken = {
  accessToken: string;
  expiresIn: number;
};

export const exchangeProviderAccessToken = async (
  gatewayURL: string,
  application: string,
  authorization: string,
  gatewayFetch: typeof fetch = fetch,
): Promise<ProviderAccessToken> => {
  const response = await gatewayFetch(
    `${gatewayURL.replace(/\/$/, "")}/idp.v1.IdentityService/ExchangeProviderToken`,
    {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        "connect-protocol-version": "1",
      },
      body: JSON.stringify({ application }),
    },
  );
  const body = (await response.json()) as ExchangeProviderTokenResponse;
  if (!response.ok) {
    throw new ConnectError(body.message ?? `provider token exchange failed (${response.status})`, Code.Internal);
  }
  if (body.authorizeUrl) {
    throw new ConnectError(`provider authorization required: ${body.authorizeUrl}`, Code.FailedPrecondition);
  }
  if (!body.accessToken) {
    throw new ConnectError("provider token exchange returned no access token", Code.Internal);
  }
  const expiresIn = Number(body.expiresIn ?? 300);
  return { accessToken: body.accessToken, expiresIn: Number.isFinite(expiresIn) ? expiresIn : 300 };
};
