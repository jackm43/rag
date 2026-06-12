export interface Env {
  AUTH_GATEWAY_URL: string;
  CLOUDFLARE_ENDPOINT: string;
  SERVICE_CLIENT_ID?: string;
  SERVICE_CLIENT_SECRET?: string;
  AUTH_GATEWAY?: Fetcher;
  CLOUDFLARE?: Fetcher;
  OTEL_SERVICE_NAME?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_HEADERS?: string;
}
