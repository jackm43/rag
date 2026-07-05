import type { AuthDecision, Principal } from "@rag/edge-kit";
import { logger } from "@rag/logger";
import { cloudflareAccessGuard } from "./access";
import { createAuth, resolveDiscordSubject } from "./web";
import { operatorControlGuard } from "./native";
import { oauth2ClientGuard } from "./oauth2";
import type { AuthEnv } from "./env";

// The client-authentication strategies, one per client kind. The auth worker
// (the API Gateway) wires these; keeping them here makes the auth library the
// single home for "how each kind of client proves who it is", reusable by any
// worker that needs to authenticate a caller.

const deny = (status: number, reason: string): AuthDecision => ({ ok: false, status, reason });

// Programmatic / machine callers: an operator bearer token, an OAuth2
// client-credentials pair, or a Cloudflare Access machine grant (service token /
// Access JWT fronting a machine-facing API). Covers "cli/native auth" and
// "oauth2 clients".
export const authenticateNative = async (request: Request, env: AuthEnv): Promise<AuthDecision> => {
  const authorization = request.headers.get("authorization") ?? "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    const op = await operatorControlGuard.verify(request, env);
    if (op.ok) {
      return { ok: true, principal: { subject: op.grant.principal, kind: "native", roles: ["operator"] } };
    }
  }
  if (authorization.toLowerCase().startsWith("basic ")) {
    const oauth2 = await oauth2ClientGuard.verify(request, env);
    if (oauth2.ok) {
      return {
        ok: true,
        principal: { subject: oauth2.grant.clientId, kind: "native", roles: ["oauth2-client"] },
      };
    }
  }
  const access = await cloudflareAccessGuard.verify(request, env);
  if (access.ok) {
    const principal: Principal = {
      subject: access.grant.identity.sub,
      kind: "native",
      roles: ["machine"],
      ...(access.grant.identity.email ? { claims: { email: access.grant.identity.email } } : {}),
    };
    return { ok: true, principal };
  }
  return deny(401, "native_unauthenticated");
};

// Human web callers: Cloudflare Access perimeter + a Better Auth Discord session.
// The session is bound to the Access identity at creation; a session under a
// different Access identity is refused (leaked-cookie defence).
export const authenticateWeb = async (request: Request, env: AuthEnv): Promise<AuthDecision> => {
  const access = await cloudflareAccessGuard.verify(request, env);
  if (!access.ok) {
    return deny(401, access.reason);
  }
  let auth;
  try {
    auth = createAuth(env);
  } catch (error) {
    logger.error("auth_unconfigured", { reason: String((error as Error).message ?? error) });
    return deny(500, "auth_unconfigured");
  }
  const subject = await resolveDiscordSubject(auth, request.headers);
  if (!subject) {
    return deny(401, "no_session");
  }
  if (subject.accessSub !== access.grant.identity.sub) {
    return deny(401, "session_access_mismatch");
  }
  const principal: Principal = {
    subject: subject.discordId,
    kind: "web",
    claims: { accessSub: subject.accessSub, ...(subject.email ? { email: subject.email } : {}) },
  };
  return { ok: true, principal };
};
