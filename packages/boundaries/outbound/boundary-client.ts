import { errorMessage, logger } from "../../logger";

export type TrustZone =
  | "egress-discord"
  | "egress-ai-gateway"
  | "egress-cloudflare-api"
  | "egress-media";

export type BoundaryCredential = {
  header: string;
  value: string;
};

export type BoundaryPolicy = {
  identity: string;
  trustZone: TrustZone;
  credential?: BoundaryCredential;
  allowedHosts: string[] | "*";
  defaultTimeoutMs: number;
  maxResponseBytes?: number;
  // Default true. Set false for identities whose request paths can embed
  // credentials (Discord webhook paths carry the interaction token) or reach
  // arbitrary hosts (media); their logs stay host-only.
  logPath?: boolean;
};

export type RequestOutcome = "ok" | "denied" | "http_error" | "timeout" | "network_error";

export type RequestContext = {
  identity: string;
  trustZone: TrustZone;
  method: string;
  host: string;
  outcome: RequestOutcome;
  status?: number;
};

export type PolicyViolationReason =
  | "invalid_url"
  | "insecure_scheme"
  | "host_not_allowed"
  | "response_too_large";

export class PolicyViolationError extends Error {
  readonly identity: string;
  readonly trustZone: TrustZone;
  readonly reason: PolicyViolationReason;

  constructor(policy: BoundaryPolicy, reason: PolicyViolationReason, detail: string) {
    super(`${policy.identity} egress denied (${reason}): ${detail}`);
    this.name = "PolicyViolationError";
    this.identity = policy.identity;
    this.trustZone = policy.trustZone;
    this.reason = reason;
  }
}

export type BoundaryFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const requestContext = (
  policy: BoundaryPolicy,
  method: string,
  url: URL | null,
  outcome: RequestOutcome,
  status?: number,
): RequestContext & { path?: string } => ({
  identity: policy.identity,
  trustZone: policy.trustZone,
  method,
  host: url?.hostname ?? "invalid",
  outcome,
  ...(status === undefined ? {} : { status }),
  ...(url && policy.logPath !== false ? { path: url.pathname } : {}),
});

const deny = (
  policy: BoundaryPolicy,
  method: string,
  url: URL | null,
  reason: PolicyViolationReason,
  detail: string,
) => {
  logger.warn("egress_denied", { ...requestContext(policy, method, url, "denied"), reason });
  return new PolicyViolationError(policy, reason, detail);
};

const headerRecord = (init: HeadersInit | undefined) => {
  const record: Record<string, string> = {};
  new Headers(init).forEach((value, key) => {
    record[key] = value;
  });
  return record;
};

const isTimeoutError = (error: unknown) =>
  error instanceof Error && error.name === "TimeoutError";

const capResponseBytes = (
  response: Response,
  policy: BoundaryPolicy,
  method: string,
  url: URL,
  maxResponseBytes: number,
) => {
  if (!response.body) {
    return response;
  }

  let receivedBytes = 0;
  const limited = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        receivedBytes += chunk.byteLength;
        if (receivedBytes > maxResponseBytes) {
          throw deny(
            policy,
            method,
            url,
            "response_too_large",
            `response body exceeds ${maxResponseBytes} bytes`,
          );
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(limited, response);
};

export const createBoundaryClient = (policy: BoundaryPolicy): BoundaryFetch => {
  const allowsHost = (host: string) =>
    policy.allowedHosts === "*" || policy.allowedHosts.includes(host);

  return async (input, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();

    let url: URL;
    try {
      url = new URL(String(input));
    } catch {
      throw deny(policy, method, null, "invalid_url", "request URL is not parseable");
    }
    if (url.protocol !== "https:") {
      throw deny(policy, method, url, "insecure_scheme", `scheme ${url.protocol} is not https`);
    }
    if (!allowsHost(url.hostname)) {
      throw deny(policy, method, url, "host_not_allowed", `host ${url.hostname} is not in the ${policy.identity} allowlist`);
    }

    const headers = headerRecord(init.headers);
    if (policy.credential) {
      headers[policy.credential.header] = policy.credential.value;
    }

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        ...init,
        headers,
        signal: init.signal ?? AbortSignal.timeout(policy.defaultTimeoutMs),
      });
    } catch (error) {
      const outcome: RequestOutcome = isTimeoutError(error) ? "timeout" : "network_error";
      logger.warn("egress_request_failed", {
        ...requestContext(policy, method, url, outcome),
        error: errorMessage(error),
      });
      throw error;
    }

    if (!response.ok) {
      logger.warn("egress_request_failed", requestContext(policy, method, url, "http_error", response.status));
    }

    if (policy.maxResponseBytes === undefined) {
      return response;
    }

    const contentLength = Number(response.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(contentLength) && contentLength > policy.maxResponseBytes) {
      throw deny(
        policy,
        method,
        url,
        "response_too_large",
        `content-length ${contentLength} exceeds ${policy.maxResponseBytes} bytes`,
      );
    }
    return capResponseBytes(response, policy, method, url, policy.maxResponseBytes);
  };
};
