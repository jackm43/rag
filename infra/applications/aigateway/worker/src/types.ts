import type { WorkerSecret } from "@platy/sdk";

export interface Env {
  AUTH_GATEWAY_URL: string;
  AUTH_GATEWAY?: Fetcher;
  CF_ACCOUNT_ID: string;
  AIG_GATEWAY_ID: string;
  AIG_DEFAULT_MODEL: string;
  AIG_ALLOWED_ORIGINS?: string;
  CF_AIG_TOKEN: WorkerSecret;
  SERVICE_CLIENT_ID?: string;
  SERVICE_CLIENT_SECRET?: WorkerSecret;
  // Ragbot connector: service binding plus base URL (same-account
  // worker-to-worker fetches require the binding; the URL names the host).
  RAGBOT?: Fetcher;
  RAGBOT_ENDPOINT?: string;
  // OTEL: service name override and optional OTLP/HTTP export target.
  OTEL_SERVICE_NAME?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
}
