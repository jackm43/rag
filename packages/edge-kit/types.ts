// The vocabulary shared between the edge middleware (`createAppWorker`) and the
// auth worker (`AuthGateway`). Public clients reach an application in one of
// three shapes; each is authenticated differently, but all three funnel into a
// single principal + a single authorization decision made by the auth worker.
// Backends trust that decision and do not re-check (API Gateway trust model).

export type ClientKind = "web" | "webhook" | "native";

// A public caller resolved after authentication. `subject` is the stable id the
// policy table and application logic key on (a Discord user id for `web`, a
// provider/event id for `webhook`, a token id for `native`). `claims` is
// free-form, non-secret context (email, provider name, guild id); never put a
// token or secret here.
export type Principal = {
  subject: string;
  kind: ClientKind;
  roles?: string[];
  claims?: Record<string, string>;
};

// What the middleware hands the auth worker to authenticate a header-based
// client (`web`, `native`). The body is deliberately excluded — signature-based
// webhook authentication needs the raw body and is verified at the edge (the
// app supplies the verifier), never delegated here.
export type AuthRequest = {
  app: string;
  clientKind: ClientKind;
  action: string;
  route: string;
  method: string;
  url: string;
  // Request headers as a plain record, `cf-*` stripped by the caller.
  headers: Record<string, string>;
};

export type AuthorizeInput = {
  principal: Principal;
  app: string;
  action: string;
  route: string;
};

// A denial carries only a status + a short machine reason (logged, never echoed
// verbatim to the caller). Success carries the resolved principal.
export type AuthOk = { ok: true; principal: Principal };
export type AuthDenied = { ok: false; status: number; reason: string };
export type AuthDecision = AuthOk | AuthDenied;

export type VerifyResult = { ok: boolean; reason?: string };
export type AuthorizeResult = { ok: boolean; status?: number; reason?: string };

// The RPC surface every public app binds as `AUTH`. The three methods are the
// stubbed pipeline the middleware calls in order: authenticate the client,
// verify the principal is still good, authorize the specific action.
export interface AuthGatewayBinding {
  authenticateClient(request: AuthRequest): Promise<AuthDecision>;
  verify(principal: Principal): Promise<VerifyResult>;
  authorize(input: AuthorizeInput): Promise<AuthorizeResult>;
  // Inbound provider-webhook verification (HMAC): the secret + computation stay
  // on the auth worker; the caller learns only { valid, eventId? }.
  verifyWebhook(input: {
    provider: string;
    signatureHeaders: Record<string, string>;
    bodyBase64: string;
  }): Promise<{ valid: boolean; eventId?: string }>;
}

// The minimum env every edge app carries: the auth binding.
export type EdgeEnv = { AUTH: AuthGatewayBinding };
