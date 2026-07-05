import { WorkerEntrypoint } from "cloudflare:workers";

import type {
  AuthDecision,
  AuthGatewayBinding,
  AuthorizeInput,
  AuthorizeResult,
  AuthRequest,
  Principal,
  VerifyResult,
} from "@rag/edge-kit";
import { authenticateNative, authenticateWeb, type AuthEnv } from "@rag/auth-kit";
import { logger } from "@rag/logger";
import { evaluate, POLICY, type PolicyEnv } from "./policy";

// The auth worker: the single API Gateway every public app authenticates
// through. It is binding-only (no public route) and exposes the three-step
// pipeline the shared edge middleware calls per request. It owns the real edge
// credentials — the Cloudflare Access JWKS, the Better Auth D1, the operator +
// oauth2 client secrets — so no other worker needs them, and it is the one place
// authorization is decided. Backends trust its verdict. The per-client-kind
// authentication strategies live in @rag/auth-kit.

type Env = AuthEnv & PolicyEnv;

const deny = (status: number, reason: string): AuthDecision => ({ ok: false, status, reason });

// The strategies take a Request. The middleware forwards a bodyless AuthRequest
// (method/url/headers); rebuild a Request so the header/cookie-based strategies
// read the same headers they would at a live edge.
const asRequest = (request: AuthRequest): Request =>
  new Request(request.url, { method: "GET", headers: request.headers });

export class AuthGateway extends WorkerEntrypoint<Env> implements AuthGatewayBinding {
  async authenticateClient(request: AuthRequest): Promise<AuthDecision> {
    switch (request.clientKind) {
      case "native":
        return authenticateNative(asRequest(request), this.env);
      case "web":
        return authenticateWeb(asRequest(request), this.env);
      case "webhook":
        // Signature-based webhook auth needs the raw body and is verified at the
        // app edge; it is never delegated here.
        return deny(401, "webhook_local_only");
    }
  }

  // Freshness / revocation hook. A stub today (sessions/tokens are validated at
  // authentication), kept as a distinct step so revocation can land here without
  // touching call sites.
  async verify(_principal: Principal): Promise<VerifyResult> {
    return { ok: true };
  }

  async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    const decision = evaluate(POLICY, this.env, input);
    if (decision.ok) {
      return { ok: true };
    }
    logger.warn("authz_denied", {
      app: input.app,
      action: input.action,
      subject: input.principal.subject,
      kind: input.principal.kind,
      reason: decision.reason,
    });
    return { ok: false, status: decision.status, reason: decision.reason };
  }
}

// Binding-only worker: no public HTTP surface.
export default {
  async fetch(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  },
};
