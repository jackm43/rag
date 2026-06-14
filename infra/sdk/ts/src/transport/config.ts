import type { TransportEnv, TransportMode } from "./types";

export const DEFAULT_TRANSPORT_MODE: TransportMode = "service-auth";

export const transportModeFromEnv = (env: TransportEnv): TransportMode =>
  env.TRANSPORT_MODE?.trim().toLowerCase() === "mtls" ? "mtls" : DEFAULT_TRANSPORT_MODE;

export const applicationFromEnv = (env: TransportEnv): string =>
  (env.PLATY_APPLICATION ?? env.OTEL_SERVICE_NAME ?? "").trim();
