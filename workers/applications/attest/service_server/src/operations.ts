import type { AttestInvokeResult, Env } from "../../../../../packages/contracts/types";
import { ATTEST_WEBHOOK_SIGNATURE_HEADERS } from "../../../../../packages/contracts";
import { handleGitHubWebhookEvent } from "./webhook";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// Parse the small filtered signature-header JSON object carried in the
// envelope, keeping only the allowed GitHub signature headers so a hostile
// or buggy caller cannot smuggle arbitrary headers through the service hop.
export const parseAttestHeaders = (value: string): Record<string, string> | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const headers: Record<string, string> = {};
  for (const key of ATTEST_WEBHOOK_SIGNATURE_HEADERS) {
    const headerValue = parsed[key];
    if (typeof headerValue === "string") {
      headers[key] = headerValue;
    }
  }
  return headers;
};

export const dispatchAttestInvoke = async (
  env: Env,
  operation: string,
  headersJson: string,
  bodyBase64: string,
): Promise<AttestInvokeResult> => {
  const headers = parseAttestHeaders(headersJson);
  if (!headers) {
    return { status: 400, body: { error: "invalid_request" } };
  }
  switch (operation) {
    case "webhook.github":
      return handleGitHubWebhookEvent(env, headers, bodyBase64);
    default:
      return { status: 400, body: { error: "invalid_request" } };
  }
};
