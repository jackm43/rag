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

export class ProviderExchangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderExchangeError";
  }
}

export const exchangeProviderAccessToken = async (
  gatewayURL: string,
  application: string,
  authorization: string,
  gatewayFetch: typeof fetch = fetch,
): Promise<ProviderAccessToken> => {
  const response = await gatewayFetch(
    `${gatewayURL.replace(/\/$/, "")}/platform/gateway/v1/provider/token/exchanges`,
    {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify({ data: { application } }),
    },
  );
  const envelope = (await response.json()) as {
    data?: ExchangeProviderTokenResponse;
    errors?: Array<{ detail?: string; title?: string }>;
  };
  const body = envelope.data ?? {};
  if (!response.ok) {
    throw new ProviderExchangeError(
      envelope.errors?.[0]?.detail ?? body.message ?? `provider token exchange failed (${response.status})`,
    );
  }
  if (!body.accessToken) {
    throw new ProviderExchangeError(body.message ?? "provider authorization required");
  }
  return {
    accessToken: body.accessToken,
    expiresIn: Number(body.expiresIn ?? 300),
  };
};
