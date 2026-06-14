import { applicationFromClientId } from "../resource/delegations";
import { logger } from "../logger";
import {
  bindingAgeValid,
  readServiceBindingVerifyRequest,
  verifyServiceBindingJwt,
} from "./service-auth";
import { requireMtlsTransport } from "./mtls";
import { TARGET_SERVICE_HEADER, TRANSPORT_MODE_HEADER } from "./tokens";
import type { TransportMode } from "./types";

const b64url = (bytes: ArrayBuffer): string => {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const requestBodyDigest = async (request: Request): Promise<string> => {
  if (request.method === "GET" || request.method === "HEAD") {
    return "";
  }
  const body = await request.clone().arrayBuffer();
  if (!body.byteLength) {
    return "";
  }
  return b64url(await crypto.subtle.digest("SHA-256", body));
};

export type InboundTransportEnv = {
  application: string;
  mode: TransportMode;
  gatewayUrl?: string;
  gatewayFetch?: typeof fetch;
};

export const verifyInboundWorkerTransport = async (
  env: InboundTransportEnv,
  request: Request,
): Promise<boolean> => {
  if (env.mode === "mtls") {
    return requireMtlsTransport(request);
  }
  const mode = request.headers.get(TRANSPORT_MODE_HEADER);
  if (mode !== "service-auth") {
    return true;
  }
  const target = request.headers.get(TARGET_SERVICE_HEADER)?.trim() ?? "";
  if (target !== env.application) {
    logger.warn("transport_target_mismatch", {
      expected: env.application,
      received: target,
      path: new URL(request.url).pathname,
    });
    return false;
  }
  const bodyDigest = await requestBodyDigest(request);
  const verifyRequest = readServiceBindingVerifyRequest(
    request.headers,
    request.method,
    request.url,
    bodyDigest,
  );
  if (!verifyRequest || !bindingAgeValid(verifyRequest.timestamp)) {
    logger.warn("transport_binding_invalid", { path: new URL(request.url).pathname });
    return false;
  }
  if (!env.gatewayUrl) {
    logger.warn("transport_verify_unconfigured", { application: env.application });
    return false;
  }
  const issuer = env.gatewayUrl.replace(/\/$/, "");
  const result = await verifyServiceBindingJwt(
    verifyRequest.token,
    { issuer, audience: env.application, gatewayFetch: env.gatewayFetch },
    {
      method: verifyRequest.method,
      path: verifyRequest.path,
      bodyDigest: verifyRequest.bodyDigest,
    },
  );
  if (!result?.valid) {
    logger.warn("transport_binding_denied", {
      caller: verifyRequest.caller,
      target: verifyRequest.target,
      path: verifyRequest.path,
    });
    return false;
  }
  const callerClient = applicationFromClientId(verifyRequest.clientId);
  if (callerClient && callerClient !== verifyRequest.caller) {
    logger.warn("transport_caller_mismatch", {
      caller: verifyRequest.caller,
      clientId: verifyRequest.clientId,
    });
    return false;
  }
  return true;
};
