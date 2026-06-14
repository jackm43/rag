import { createDpopProof, DPOP_HEADER, type DpopKey } from "../oauth2/dpop";

export type TokenSource = () => Promise<string | null>;

export type ClientConfig = {
  endpoint: string;
  token?: TokenSource;
  dpop?: DpopKey;
  decorate?: (headers: Headers) => void | Promise<void>;
  fetch?: typeof fetch;
};

export type PlatformClient = {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
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

  return { fetch: doFetch };
};
