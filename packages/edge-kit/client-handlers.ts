import { logger } from "@rag/logger";
import type {
  AuthOk,
  ClientKind,
  EdgeEnv,
  Principal,
  AuthRequest,
} from "./types";

// A client handler turns a raw inbound request into an authenticated principal
// or a denial Response. `web` and `native` are header-based and delegate
// authentication to the auth worker; `webhook` is signature-based (needs the
// raw body) and is verified at the edge with an app-supplied verifier, since the
// signing key/public key is per-app config. All three still go through the auth
// worker's `authorize` afterwards — that step lives in the middleware, not here.

export type ClientHandlerInput<Env extends EdgeEnv> = {
  request: Request;
  env: Env;
  app: string;
  action: string;
  route: string;
};

export type ClientHandlerResult =
  | AuthOk
  | { ok: false; response: Response };

export type ClientHandler<Env extends EdgeEnv> = (
  input: ClientHandlerInput<Env>,
) => Promise<ClientHandlerResult>;

const unauthorized = () => new Response("Unauthorized", { status: 401 });
const denyStatus = (status: number) =>
  new Response(status === 403 ? "Forbidden" : "Unauthorized", { status });

// Headers as a plain record with `cf-*` (Cloudflare-injected) stripped, so the
// auth worker sees only client-controlled headers plus what it explicitly reads
// (the Access assertion header is not `cf-*`-prefixed on the assertion itself,
// so it survives — Cloudflare sets `cf-access-jwt-assertion`, which IS stripped;
// the auth worker reads Access from its own bound context instead). We keep the
// common auth-bearing headers regardless.
const KEEP_CF_HEADERS = new Set(["cf-access-jwt-assertion"]);

const headersRecord = (request: Request): Record<string, string> => {
  const out: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (!lower.startsWith("cf-") || KEEP_CF_HEADERS.has(lower)) {
      out[key] = value;
    }
  });
  return out;
};

const authRequest = (
  input: ClientHandlerInput<EdgeEnv>,
  clientKind: ClientKind,
): AuthRequest => ({
  app: input.app,
  clientKind,
  action: input.action,
  route: input.route,
  method: input.request.method,
  url: input.request.url,
  headers: headersRecord(input.request),
});

// Delegated authentication shared by the `web` and `native` handlers: build the
// bodyless AuthRequest and let the auth worker resolve the principal.
const delegated =
  (clientKind: ClientKind): ClientHandler<EdgeEnv> =>
  async (input) => {
    const decision = await input.env.AUTH.authenticateClient(
      authRequest(input, clientKind),
    );
    if (decision.ok) {
      return { ok: true, principal: decision.principal };
    }
    logger.warn("edge_authn_denied", {
      app: input.app,
      clientKind,
      action: input.action,
      reason: decision.reason,
    });
    return { ok: false, response: denyStatus(decision.status) };
  };

// Session-cookie / Cloudflare Access. The auth worker owns the Better Auth D1
// and the Access JWKS, so it resolves the acting subject from the forwarded
// headers.
export const webClient: ClientHandler<EdgeEnv> = delegated("web");

// Bearer / operator token. The auth worker compares against its configured
// tokens and returns the token's principal.
export const nativeClient: ClientHandler<EdgeEnv> = delegated("native");

// Signature-based provider webhook. The app supplies `verify`, which checks the
// request signature (Discord Ed25519, provider HMAC, …) against the raw body and
// returns the resolved principal or null. Authentication is local; authorization
// still runs through the auth worker in the middleware.
export type WebhookVerifier<Env extends EdgeEnv> = (
  request: Request,
  env: Env,
) => Promise<Principal | null>;

export const webhookClient =
  <Env extends EdgeEnv>(verify: WebhookVerifier<Env>): ClientHandler<Env> =>
  async (input) => {
    let principal: Principal | null = null;
    try {
      principal = await verify(input.request, input.env);
    } catch {
      principal = null;
    }
    if (!principal) {
      logger.warn("edge_webhook_denied", { app: input.app, action: input.action });
      return { ok: false, response: unauthorized() };
    }
    return { ok: true, principal };
  };

export const defaultClientHandlers = <Env extends EdgeEnv>(): Record<
  ClientKind,
  ClientHandler<Env>
> => ({
  web: webClient as ClientHandler<Env>,
  native: nativeClient as ClientHandler<Env>,
  // No default webhook verifier — an app that exposes `webhook` routes must
  // supply one via `clients.webhook`. The placeholder denies until it does.
  webhook: async () => ({ ok: false, response: unauthorized() }),
});
