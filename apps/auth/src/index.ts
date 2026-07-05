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
import { cloudflareAccessGuard } from "@rag/ingress/cf-access";
import { createAuth, resolveDiscordSubject } from "@rag/ingress/better-auth";
import { operatorControlGuard } from "@rag/ingress/operator-control";
import type { IngressEnv } from "@rag/ingress/env";
import { logger } from "@rag/logger";
import { evaluate, POLICY, type PolicyEnv } from "./policy";

// The auth worker: the single API Gateway every public app authenticates
// through. It is binding-only (no public route) and exposes the three-step
// pipeline the shared edge middleware calls per request. It owns the real edge
// credentials — the Cloudflare Access JWKS, the Better Auth D1, the operator
// token — so no other worker needs them, and it is the one place authorization
// is decided. Backends trust its verdict.

type Env = IngressEnv & PolicyEnv;

const deny = (status: number, reason: string): AuthDecision => ({ ok: false, status, reason });

// The ingress guards take a Request. The middleware forwards a bodyless
// AuthRequest (method/url/headers); rebuild a Request so the guards read the
// same headers/cookies they would at a live edge. No body is needed — every
// header-based guard authenticates from headers alone.
const asRequest = (request: AuthRequest): Request =>
  new Request(request.url, { method: "GET", headers: request.headers });

export class AuthGateway extends WorkerEntrypoint<Env> implements AuthGatewayBinding {
  async authenticateClient(request: AuthRequest): Promise<AuthDecision> {
    switch (request.clientKind) {
      case "native":
        return this.authenticateNative(asRequest(request));
      case "web":
        return this.authenticateWeb(asRequest(request));
      case "webhook":
        // Signature-based webhook auth needs the raw body and is verified at the
        // app edge; it is never delegated here.
        return deny(401, "webhook_local_only");
    }
  }

  private async authenticateNative(request: Request): Promise<AuthDecision> {
    const result = await operatorControlGuard.verify(request, this.env);
    if (!result.ok) {
      return deny(401, result.reason);
    }
    const principal: Principal = { subject: result.grant.principal, kind: "native", roles: ["operator"] };
    return { ok: true, principal };
  }

  private async authenticateWeb(request: Request): Promise<AuthDecision> {
    // Perimeter: the request must genuinely have passed Cloudflare Access.
    const access = await cloudflareAccessGuard.verify(request, this.env);
    if (!access.ok) {
      return deny(401, access.reason);
    }
    let auth;
    try {
      auth = createAuth(this.env);
    } catch (error) {
      logger.error("auth_unconfigured", { reason: String((error as Error).message ?? error) });
      return deny(500, "auth_unconfigured");
    }
    const subject = await resolveDiscordSubject(auth, request.headers);
    if (!subject) {
      return deny(401, "no_session");
    }
    // The session was bound to an Access identity at creation; a session
    // presented under a different Access identity is refused (leaked-cookie
    // defence).
    if (subject.accessSub !== access.grant.identity.sub) {
      return deny(401, "session_access_mismatch");
    }
    const principal: Principal = {
      subject: subject.discordId,
      kind: "web",
      claims: { accessSub: subject.accessSub, ...(subject.email ? { email: subject.email } : {}) },
    };
    return { ok: true, principal };
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
