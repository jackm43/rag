import type { components } from "./api-types";

// Typed client for the ragbot dev-proxy HTTP API, for out-of-worker consumers
// such as ragctl. It is deliberately a "dumb" web client (matching the client-
// library design pattern): it owns no credentials — the caller supplies them
// through hooks, so credential handling stays where the secrets live. The
// request/response shapes come from the OpenAPI contract's generated types
// (api-types.ts, `npm run devproxy:types`), so the client cannot drift from the
// worker's ingress.
//
// Auth is layered and cookie/token based (no per-request proof): the dev-proxy
// sits behind Cloudflare Access AND requires a Better Auth session.
//   - accessToken: the Cloudflare Access application token (Cf-Access-Jwt-
//     Assertion). Optional — a caller running behind `cloudflared access` may
//     have Access inject it instead.
//   - sessionCookie: the Better Auth session cookie(s). In a browser this is
//     sent automatically (same-origin credentials); an out-of-worker caller must
//     supply the Cookie header explicitly, as there is no cookie jar.

export type CommandRequest = components["schemas"]["CommandRequest"];
export type GithubApiRequest = components["schemas"]["GithubApiRequest"];

export type DevProxyClientOptions = {
  // Base URL of the dev-proxy, e.g. "https://ragbot-dev.jsmunro.me".
  baseUrl: string;
  // Returns the Cloudflare Access application token for the
  // Cf-Access-Jwt-Assertion header. Optional (see note above).
  accessToken?: () => string | Promise<string>;
  // Returns the Better Auth session Cookie header value. Optional for browsers
  // (the cookie rides along same-origin); required for non-browser callers.
  sessionCookie?: () => string | Promise<string>;
  // Injectable fetch (tests / non-global environments).
  fetch?: typeof fetch;
};

export type DevProxyResponse = {
  status: number;
  body: unknown;
  contentType: string;
  json: boolean;
};

export type DevProxyClient = {
  command: (request: CommandRequest) => Promise<DevProxyResponse>;
  github: (request: GithubApiRequest) => Promise<DevProxyResponse>;
};

export const createDevProxyClient = (options: DevProxyClientOptions): DevProxyClient => {
  const doFetch = options.fetch ?? fetch;
  const headers = async (): Promise<Record<string, string>> => {
    const requestHeaders: Record<string, string> = {
      "content-type": "application/json",
    };
    if (options.accessToken) {
      requestHeaders["Cf-Access-Jwt-Assertion"] = await options.accessToken();
    }
    if (options.sessionCookie) {
      requestHeaders.Cookie = await options.sessionCookie();
    }
    return requestHeaders;
  };
  const postJson = async (path: string, request: unknown): Promise<DevProxyResponse> => {
    const url = new URL(path, options.baseUrl).toString();
    const response = await doFetch(url, {
      method: "POST",
      headers: await headers(),
      body: JSON.stringify(request),
      // Send the session cookie for same-origin browser callers.
      credentials: "include",
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return { status: response.status, contentType, json: true, body: await response.json().catch(() => null) };
    }
    return { status: response.status, contentType, json: false, body: await response.text().catch(() => "") };
  };
  return {
    command: (request) => postJson("/api/command", request),
    github: (request) => postJson("/api/github", request),
  };
};
