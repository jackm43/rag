import { createClient, ensureRegistered } from "../../../../../../packages/auth";
import { ATTEST_WEBHOOK_SIGNATURE_HEADERS, encodeAttestInvokeEnvelope, MAX_WEBHOOK_BODY_BYTES } from "../../../../../../packages/contracts";
import type { AttestInvokeResult, Env } from "../../../../../../packages/contracts/types";
import { ATTEST_MANIFEST, AttestationStore, AttestService } from "../../../service_server/src";
import { OPENAPI } from "./openapi";

export { AttestationStore };
export { AttestService };

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const base64Of = (bytes: Uint8Array): string => {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
};

// String bodies relay as plain text (the pre-refactor webhook responses:
// "OK", "Ignored", "Bad request signature"); object bodies relay as JSON.
const relay = (result: AttestInvokeResult): Response =>
  typeof result.body === "string"
    ? new Response(result.body, { status: result.status })
    : json(result.status, result.body);

const invokeAttest = async (
  env: Env,
  headers: Record<string, string>,
  bodyBase64: string,
): Promise<Response> => {
  if (!env.ATTEST_SERVICE) {
    return json(500, { error: "attest_service_unbound" });
  }
  await ensureRegistered(env, ATTEST_MANIFEST);
  const envelope = encodeAttestInvokeEnvelope(
    {
      kind: "attest.invoke",
      operation: "webhook.github",
      headersJson: JSON.stringify(headers),
      bodyBase64,
    },
    { source: "worker" },
  );
  const message = await createClient({
    env,
    self: "attest",
    context: { subject: "github:webhook" },
    transportTrust: "application",
  }).to("attest").prepare(envelope);
  return relay(await env.ATTEST_SERVICE.invoke(message));
};

const handleGitHubWebhook = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  }
  const declaredLength = Number(request.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BODY_BYTES) {
    return new Response("Payload too large", { status: 413 });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    return new Response("Payload too large", { status: 413 });
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    ctx.waitUntil(ensureRegistered(env, ATTEST_MANIFEST));
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json(200, { ok: true, service: "attest" });
    }
    if (request.method === "GET" && url.pathname === "/openapi.json") {
      return json(200, OPENAPI);
    }
    if (url.pathname === "/github") {
      return handleGitHubWebhook(request, env);
    }
    return new Response("Not found", { status: 404 });
  },
};
