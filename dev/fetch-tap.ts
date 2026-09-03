// Per-request outbound fetch interception for the dev harness.
//
// The bot's library code calls the global `fetch` directly (Discord REST, the AI
// Gateway, media downloads). To simulate a Discord event without touching the
// real guild, the harness installs one global wrapper around `fetch` that consults
// an AsyncLocalStorage store: inside a simulation every outbound call is routed
// through the simulation's handler (which stubs discord.com and records the AI
// Gateway exchange); outside a simulation the original `fetch` is used untouched.
// `nodejs_compat` provides AsyncLocalStorage in workerd, and the store is scoped
// to the async context of one simulation, so concurrent requests never bleed
// into each other's captures.
import { AsyncLocalStorage } from "node:async_hooks";

export type CapturedCall = {
  // Sequence number in the order calls left the worker.
  seq: number;
  method: string;
  url: string;
  // Request headers with credentials redacted.
  headers: Record<string, string>;
  // Parsed JSON body when the request was JSON, a summary otherwise.
  body: unknown;
  // How the call was answered: a local stub, or forwarded upstream.
  routed: "stub" | "upstream";
  note?: string;
  response?: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
  };
  durationMs: number;
};

export type CapturedLog = { level: string; message: string; data?: Record<string, unknown> };

// A handler answers a call with a stub Response, hands back a (possibly
// rewritten) Request to forward upstream, or returns undefined to forward the
// original request unchanged.
export type TapHandler = (request: Request, call: CapturedCall) => Promise<Response | Request | undefined>;

type TapStore = {
  handler: TapHandler;
  upstream: typeof fetch;
  calls: CapturedCall[];
  logs: CapturedLog[];
};

const storage = new AsyncLocalStorage<TapStore>();

const REDACTED_HEADERS = new Set(["authorization", "cf-aig-authorization", "x-auth-key", "cookie"]);

export const redactHeaders = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = REDACTED_HEADERS.has(key.toLowerCase()) ? "<redacted>" : value;
  });
  return out;
};

const summarizeFormData = async (request: { formData(): Promise<FormData> }) => {
  const form = await request.formData();
  const fields: Record<string, unknown> = {};
  form.forEach((value, key) => {
    if (typeof value === "string") {
      fields[key] = key === "payload_json" ? safeJson(value) : value;
    } else {
      fields[key] = { file: value.name, type: value.type, bytes: value.size };
    }
  });
  return { formData: fields };
};

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

export const readRequestBody = async (request: Request): Promise<unknown> => {
  if (request.method === "GET" || request.method === "HEAD" || request.body === null) {
    return undefined;
  }
  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("multipart/form-data")) {
      return await summarizeFormData(request.clone());
    }
    const text = await request.clone().text();
    return contentType.includes("json") ? safeJson(text) : text;
  } catch (error) {
    return { unreadable: String(error) };
  }
};

export const readResponseBody = async (response: Response): Promise<unknown> => {
  const contentType = response.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("json") || contentType.includes("text/")) {
      const text = await response.clone().text();
      return contentType.includes("json") ? safeJson(text) : text;
    }
    const bytes = await response.clone().arrayBuffer();
    return { binary: true, contentType, bytes: bytes.byteLength };
  } catch (error) {
    return { unreadable: String(error) };
  }
};

let originalFetch: typeof fetch | null = null;

// Idempotent: wraps the global fetch once for the isolate's lifetime.
export const installFetchTap = () => {
  if (originalFetch) {
    return;
  }
  // Bound: workerd's fetch throws "Illegal invocation" when called without
  // globalThis as its receiver.
  const real = globalThis.fetch.bind(globalThis) as typeof fetch;
  originalFetch = real;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const store = storage.getStore();
    if (!store) {
      return real(input, init);
    }

    const request = new Request(input, init);
    const startedAt = Date.now();
    const call: CapturedCall = {
      seq: store.calls.length + 1,
      method: request.method,
      url: request.url,
      headers: redactHeaders(request.headers),
      body: await readRequestBody(request),
      routed: "stub",
      durationMs: 0,
    };
    store.calls.push(call);

    const routed = await store.handler(request, call);
    let response: Response;
    if (routed instanceof Response) {
      response = routed;
    } else {
      const outbound = routed ?? request;
      call.routed = "upstream";
      call.headers = redactHeaders(outbound.headers);
      // workers-types gives a constructed Request narrower Cf generics than
      // fetch's parameter; the runtime object is a plain Request either way.
      response = await store.upstream(outbound as unknown as Request);
    }
    call.durationMs = Date.now() - startedAt;
    call.response = {
      status: response.status,
      headers: redactHeaders(response.headers),
      body: await readResponseBody(response),
    };
    return response;
  }) as typeof fetch;
};

const CONSOLE_LEVELS = ["debug", "info", "warn", "error"] as const;
let consoleTapped = false;

// The bot's logger writes one JSON line per event via console.*; mirror those
// into the active simulation so the UI can show what the worker logged for a
// run, without changing what reaches the wrangler dev terminal.
export const installConsoleTap = () => {
  if (consoleTapped) {
    return;
  }
  consoleTapped = true;
  for (const level of CONSOLE_LEVELS) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const store = storage.getStore();
      if (store) {
        const first = args[0];
        const parsed = typeof first === "string" ? safeJson(first) : first;
        if (parsed && typeof parsed === "object" && "message" in parsed) {
          const { level: _level, message, ...data } = parsed as Record<string, unknown>;
          store.logs.push({ level, message: String(message), data });
        } else {
          store.logs.push({ level, message: args.map(String).join(" ") });
        }
      }
      original(...args);
    };
  }
};

export type TapRun<T> = {
  result: T;
  calls: CapturedCall[];
  logs: CapturedLog[];
};

// Runs `body` with every outbound fetch routed through `handler`. `upstream` is
// what unhandled calls fall through to (the real fetch by default; tests pass a
// stub so the AI Gateway never sees them).
export const runWithFetchTap = async <T>(
  handler: TapHandler,
  body: () => Promise<T>,
  upstream?: typeof fetch,
): Promise<TapRun<T>> => {
  installFetchTap();
  installConsoleTap();
  const store: TapStore = {
    handler,
    upstream: upstream ?? originalFetch ?? globalThis.fetch,
    calls: [],
    logs: [],
  };
  const result = await storage.run(store, body);
  return { result, calls: store.calls, logs: store.logs };
};
