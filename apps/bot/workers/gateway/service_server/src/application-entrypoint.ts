import { WorkerEntrypoint } from "cloudflare:workers";

import { createClient, createHopIntent, ensureRegistered, SYSTEM_SUBJECT } from "@rag/service-kit";
import { encodeApplicationRequestEnvelope, MAX_APPLICATION_BODY_BYTES, type PreparedApplicationRequest } from "@rag/egress/contracts";
import type { Env } from "@rag/discord/contracts";
import { envelopeSha256 } from "@rag/service-kit/identity";
import { errorMessage, logger } from "@rag/logger";
import { GATEWAY_MANIFEST } from "./manifest";

const HEADER_APPLICATION_ID = "x-rag-application-id";
const HEADER_OPERATION_ID = "x-rag-operation-id";
const HEADER_SERVICE_OPERATION = "x-rag-service-operation";
const HEADER_LINKED_APP_TOKEN = "x-rag-linked-app-token";

const APPLICATION_ID_PATTERN = /^[a-z][a-z0-9-]{2,63}$/;
const OPERATION_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;

const header = (request: Request, name: string): string | null => {
  const value = request.headers.get(name);
  return value && value.trim().length > 0 ? value : null;
};

const base64Of = (bytes: Uint8Array): string => {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
};

const headersJson = (request: Request): string => {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (!normalized.startsWith("cf-") && normalized !== HEADER_LINKED_APP_TOKEN) {
      headers[key] = value;
    }
  });
  return JSON.stringify(headers);
};

// Service-binding RPC entrypoint for generated application middleware clients.
// It is intentionally not part of the gateway's public OpenAPI route table.
// Generated middleware clients validate public/app-facing HTTP and then call
// this entrypoint over a Cloudflare service binding. The gateway creates the
// signed application.request ServiceMessage; the middleware then performs its
// statically configured final hop to the generated application service server.
export class ApplicationMiddleware extends WorkerEntrypoint<Env> {
  async prepare(request: Request): Promise<PreparedApplicationRequest> {
    await ensureRegistered(this.env, GATEWAY_MANIFEST);

    const applicationId = header(request, HEADER_APPLICATION_ID);
    const operationId = header(request, HEADER_OPERATION_ID);
    const serviceOperation = header(request, HEADER_SERVICE_OPERATION);
    const linkedAppToken = header(request, HEADER_LINKED_APP_TOKEN);
    if (
      !applicationId ||
      !APPLICATION_ID_PATTERN.test(applicationId) ||
      !operationId ||
      !OPERATION_PATTERN.test(operationId) ||
      !serviceOperation ||
      !OPERATION_PATTERN.test(serviceOperation) ||
      !linkedAppToken
    ) {
      return { ok: false, status: 400, error: "invalid_application_forward" };
    }

    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > MAX_APPLICATION_BODY_BYTES) {
      return { ok: false, status: 413, error: "application_body_too_large" };
    }

    try {
      const envelope = encodeApplicationRequestEnvelope(
        {
          kind: "application.request",
          applicationId,
          operationId,
          serviceOperation,
          method: request.method,
          url: request.url,
          headersJson: headersJson(request),
          bodyBase64: base64Of(bytes),
          linkedTokenSha256: await envelopeSha256(new TextEncoder().encode(linkedAppToken)),
        },
        { source: "worker" },
      );
      const message = await createClient({
        env: this.env,
        self: "gateway",
        context: { subject: SYSTEM_SUBJECT, delegates: [] },
      }).to("application-service", { transportTrust: "trusted" }).prepare(envelope, {
        intent: createHopIntent({
          action: "application.invoke",
          resourceType: "Application",
          resourceId: applicationId,
          method: serviceOperation,
        }),
      });
      return { ok: true, message };
    } catch (error) {
      logger.warn("application_prepare_failed", {
        applicationId,
        operationId,
        serviceOperation,
        error: errorMessage(error),
      });
      return { ok: false, status: 403, error: "application_prepare_denied" };
    }
  }
}
