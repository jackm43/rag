export interface Env {
  AUTH_GATEWAY_URL: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  SERVICE_CLIENT_ID?: string;
  SERVICE_CLIENT_SECRET?: string;
  AUTH_GATEWAY?: Fetcher;
  OTEL_SERVICE_NAME?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
}
