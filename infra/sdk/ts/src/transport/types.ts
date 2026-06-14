import type { ServiceCredential } from "../oauth2/credential";
import type { Identity } from "../identity";

export type TransportMode = "service-auth" | "mtls";

export type TransportEnv = {
  TRANSPORT_MODE?: string;
  OTEL_SERVICE_NAME?: string;
  PLATY_APPLICATION?: string;
};

export type WorkerTransportContext = {
  mode: TransportMode;
  caller: string;
  target: string;
  credential: ServiceCredential;
  identity?: Identity;
  gatewayUrl?: string;
  gatewayFetch?: typeof fetch;
};

export type ServiceBindingVerifyRequest = {
  caller: string;
  target: string;
  method: string;
  path: string;
  bodyDigest: string;
  timestamp: number;
  token: string;
  clientId: string;
};

export type ServiceBindingVerifyResponse = {
  valid: boolean;
  caller?: string;
  target?: string;
};
