import { WorkerEntrypoint } from "cloudflare:workers";

import { createServiceServer, ensureRegistered } from "@rag/service-kit";
import { decodeAttestInvokeEnvelope } from "../../../../contracts";
import type { AttestInvokeResult, Env } from "../../../../contracts";
import type { ServiceMessageBytes } from "@rag/contracts-core";
import { ATTEST_MANIFEST } from "./manifest";
import { dispatchAttestInvoke } from "./operations";

const server = (env: Env) => createServiceServer({
  self: "attest",
  expectedIssuers: ["attest"],
  env,
  operations: ATTEST_MANIFEST.operations,
});

const denied = (): AttestInvokeResult => ({
  status: 403,
  body: { error: "attest_request_denied" },
});

export const handleAttestInvoke = async (
  env: Env,
  message: ServiceMessageBytes,
): Promise<AttestInvokeResult> => {
  await ensureRegistered(env, ATTEST_MANIFEST);
  const request = await server(env).receive(message, decodeAttestInvokeEnvelope, "binding");
  if (!request) {
    return denied();
  }

  return dispatchAttestInvoke(
    env,
    request.payload.operation,
    request.payload.headersJson,
    request.payload.bodyBase64,
  );
};

export class AttestService extends WorkerEntrypoint<Env> {
  async invoke(message: ServiceMessageBytes): Promise<AttestInvokeResult> {
    return handleAttestInvoke(this.env, message);
  }
}
