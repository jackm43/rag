export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export type HttpAuthMode =
  | "none"
  | "gateway-session"
  | "gateway-jwt"
  | "cloudflare-access"
  | "provider-credential"
  | "workload-federation";

export type IdentityContextRequirement =
  | "none"
  | "dpop"
  | "client-instance"
  | "signed-webhook"
  | "workload-proof"
  | "mtls";

export interface ApiDescriptor {
  namespace: string;
  apiName: string;
  version: `v${number}`;
  audience: string;
}

export interface RouteContract extends ApiDescriptor {
  method: HttpMethod;
  path: `/${string}`;
  operationId: string;
  summary?: string;
  description?: string;
  auth: HttpAuthMode;
  identityContext: IdentityContextRequirement;
  scopes?: string[];
  tags?: string[];
  csrf?: "standard" | "alternate-verifier";
  alternateVerifier?: "signed-webhook" | "oauth-state" | "dpop" | "bearer-token";
}

export interface ApiError {
  status: number;
  code: string;
  title: string;
  detail?: string;
  requestId?: string;
}

export interface ApiResponse<T> {
  data: T;
  meta?: Record<string, unknown>;
  _links?: ApiLink[];
}

export interface ApiErrorResponse {
  errors: ApiError[];
  meta?: Record<string, unknown>;
}

export interface ApiLink {
  href: string;
  rel: string;
  method?: HttpMethod;
}
