import { createDpopProof, DPOP_HEADER, type DpopKey } from "../verify/dpop";
import { chainExchange, exchangeToken, type ExchangedToken, type ServiceCredential } from "./exchange";
import { TOKEN_TYPE_SERVICE_CREDENTIAL } from "../verify/sts";

// TokenSource yields a bearer token for the configured target audience.
export type TokenSource = () => Promise<string | null>;

export type ClientConfig = {
  // Application base URL; relative paths passed to fetch/call resolve
  // against it.
  endpoint: string;
  token?: TokenSource;
  // When set, every request carries a fresh DPoP proof bound to this key.
  dpop?: DpopKey;
  decorate?: (headers: Headers) => void | Promise<void>;
  fetch?: typeof fetch;
};

export type PlatformClient = {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  call: <T = unknown>(path: string, body?: unknown) => Promise<T>;
};

export class ClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ClientError";
  }
}

const decodeBody = (payload: string): unknown => {
  if (!payload) {
    return null;
  }
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
};

// createClient is the standard outbound request client. Any runtime with
// fetch (worker, browser, node) configures an endpoint plus a token source
// and gets back a fetch that handles auth, proof-of-possession, and
// per-application decoration.
export const createClient = (config: ClientConfig): PlatformClient => {
  const transport = config.fetch ?? globalThis.fetch.bind(globalThis);
  const base = config.endpoint.replace(/\/$/, "");
  const resolveUrl = (input: string): string =>
    /^https?:/i.test(input) ? input : `${base}${input.startsWith("/") ? "" : "/"}${input}`;

  const doFetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = resolveUrl(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    if (config.token && !headers.has("authorization")) {
      const token = await config.token();
      if (token) {
        headers.set("authorization", `Bearer ${token}`);
      }
    }
    if (config.dpop) {
      headers.set(DPOP_HEADER, await createDpopProof(config.dpop, { method, url }));
    }
    await config.decorate?.(headers);
    return transport(url, { ...init, method, headers });
  };

  const call = async <T = unknown>(path: string, body?: unknown): Promise<T> => {
    const response = await doFetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "connect-protocol-version": "1" },
      body: JSON.stringify(body ?? {}),
    });
    const decoded = decodeBody(await response.text());
    if (!response.ok) {
      throw new ClientError(`${path} failed with status ${response.status}`, response.status, decoded);
    }
    return decoded as T;
  };

  return { fetch: doFetch, call };
};

const cached = (refresh: () => Promise<ExchangedToken | null>): TokenSource => {
  let token: string | null = null;
  let expiresAt = 0;
  return async () => {
    const now = Math.floor(Date.now() / 1000);
    if (token && now < expiresAt - 15) {
      return token;
    }
    const exchanged = await refresh();
    if (!exchanged) {
      token = null;
      return null;
    }
    token = exchanged.accessToken;
    expiresAt = now + exchanged.expiresIn;
    return token;
  };
};

// serviceTokenSource authenticates as the service itself.
export const serviceTokenSource = (
  gatewayUrl: string,
  credential: ServiceCredential,
  audience: string,
  scopes?: string[],
): TokenSource =>
  cached(() =>
    exchangeToken(gatewayUrl, {
      subjectToken: `${credential.clientId}:${credential.clientSecret}`,
      subjectTokenType: TOKEN_TYPE_SERVICE_CREDENTIAL,
      audience,
      scopes,
    }),
  );

// chainedTokenSource exchanges the calling user's token with the service
// credential as actor, preserving the delegation chain in the issued token.
export const chainedTokenSource = (
  gatewayUrl: string,
  credential: ServiceCredential,
  audience: string,
  callerToken: string,
  scopes?: string[],
): TokenSource => {
  const refresh = cached(() => chainExchange(gatewayUrl, callerToken, credential, audience, scopes));
  return refresh;
};
