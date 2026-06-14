import { logger } from "../logger";

type TlsClientAuth = {
  certIssuerDN?: string;
  certSubjectDN?: string;
  certNotBefore?: string;
  certNotAfter?: string;
  certFingerprintSHA256?: string;
};

export const mtlsIdentityFromRequest = (request: Request): { sub: string } | null => {
  const tls = (request as Request & { cf?: { tlsClientAuth?: TlsClientAuth } }).cf?.tlsClientAuth;
  if (!tls?.certSubjectDN) {
    return null;
  }
  return { sub: tls.certSubjectDN };
};

export const requireMtlsTransport = (request: Request): boolean => {
  const identity = mtlsIdentityFromRequest(request);
  if (!identity) {
    logger.warn("transport_mtls_missing", { path: new URL(request.url).pathname });
    return false;
  }
  return true;
};
