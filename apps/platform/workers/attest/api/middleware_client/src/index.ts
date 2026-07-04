import { base64Of, createEdgeWorker, jsonResponse, prepareApplicationHop, readCappedBody } from "@rag/service-kit/edge";
import { ATTEST_WEBHOOK_SIGNATURE_HEADERS, encodeAttestInvokeEnvelope } from "../../../../../contracts";
import { MAX_WEBHOOK_BODY_BYTES } from "@rag/connectors/contracts";
import type { AttestInvokeResult, Env } from "../../../../../contracts";
import { ATTEST_MANIFEST, AttestationStore, AttestService } from "../../../service_server/src";
import { OPENAPI } from "./openapi";

export { AttestationStore };
export { AttestService };

// String bodies relay as plain text (the pre-refactor webhook responses:
// "OK", "Ignored", "Bad request signature"); object bodies relay as JSON.
const relay = (result: AttestInvokeResult): Response =>
  typeof result.body === "string"
    ? new Response(result.body, { status: result.status })
    : jsonResponse(result.status, result.body);

const invokeAttest = async (
  env: Env,
  headers: Record<string, string>,
  bodyBase64: string,
): Promise<Response> => {
  if (!env.ATTEST_SERVICE) {
    return jsonResponse(500, { error: "attest_service_unbound" });
  }
  const message = await prepareApplicationHop({
    env,
    self: "attest",
    target: "attest",
    subject: "github:webhook",
    manifest: ATTEST_MANIFEST,
    envelope: encodeAttestInvokeEnvelope(
      {
        kind: "attest.invoke",
        operation: "webhook.github",
        headersJson: JSON.stringify(headers),
        bodyBase64,
      },
      { source: "worker" },
    ),
  });
  return relay(await env.ATTEST_SERVICE.invoke(message));
};

const handleGitHubWebhook = async (request: Request, env: Env): Promise<Response> => {
  const bytes = await readCappedBody(request, MAX_WEBHOOK_BODY_BYTES);
  if (bytes instanceof Response) {
    return bytes;
  }

  const headers: Record<string, string> = {};
  for (const key of ATTEST_WEBHOOK_SIGNATURE_HEADERS) {
    const value = request.headers.get(key);
    if (value !== null) {
      headers[key] = value;
    }
  }

  return invokeAttest(env, headers, base64Of(bytes));
};

export default createEdgeWorker<Env>({
  service: "attest",
  manifest: ATTEST_MANIFEST,
  openapi: OPENAPI,
  routes: [
    {
      match: "/github",
      methods: { POST: (request, env) => handleGitHubWebhook(request, env) },
    },
  ],
});
