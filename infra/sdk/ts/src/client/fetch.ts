import { createDpopProof, DPOP_HEADER, type DpopKey } from "../verify/dpop";

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
    let bearer: string | null = null;
    if (config.token && !headers.has("authorization")) {
      bearer = await config.token();
      if (bearer) {
        headers.set("authorization", `Bearer ${bearer}`);
      }
    } else {
      bearer = /^bearer\s+(.+)$/i.exec(headers.get("authorization") ?? "")?.[1]?.trim() ?? null;
    }
    if (config.dpop && bearer) {
      headers.set(DPOP_HEADER, await createDpopProof(config.dpop, { method, url }, bearer));
    } else if (config.dpop) {
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
