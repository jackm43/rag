import { HTTPException } from "hono/http-exception";
import type { MiddlewareHandler } from "hono";

import { verifyDpopProof, type DpopProof } from "../oauth2/dpop";
import type { IdentityContextRequirement, RouteContract } from "./types";

export interface IdentityContext {
  proof: IdentityContextRequirement;
  subject?: string;
  actor?: string;
  clientInstance?: string;
  dpop?: DpopProof;
}

export interface RequestContext {
  requestId: string;
  method: string;
  url: string;
  route: string;
  audience: string;
  scopes: string[];
  authorizationToken?: string;
  traceparent?: string;
}

export interface PlatformHonoVariables {
  requestId: string;
  identityContext?: IdentityContext;
  requestContext?: RequestContext;
  identity?: import("../identity").Identity;
}

export interface IdentityContextVerifierInput {
  request: Request;
  route: RouteContract;
  requestContext: RequestContext;
}

export type IdentityContextVerifier = (
  input: IdentityContextVerifierInput,
) => IdentityContext | Promise<IdentityContext>;

export interface IdentityContextVerifiers {
  clientInstance?: IdentityContextVerifier;
  signedWebhook?: IdentityContextVerifier;
  workloadProof?: IdentityContextVerifier;
  mtls?: IdentityContextVerifier;
}

const bearerToken = (headers: Headers): string | null => {
  const authorization = headers.get("authorization") ?? "";
  const match = /^bearer\s+(.+)$/i.exec(authorization);
  return match?.[1] ?? null;
};

const requestIdFromContext = (get: (key: "requestId") => string | undefined): string =>
  get("requestId") ?? crypto.randomUUID();

export function requireIdentityContext<Bindings extends object = Record<string, never>>(
  route: RouteContract,
  verifiers: IdentityContextVerifiers = {},
): MiddlewareHandler<{ Bindings: Bindings; Variables: PlatformHonoVariables }> {
  return async (c, next) => {
    const authorizationToken = bearerToken(c.req.raw.headers) ?? undefined;
    const requestContext: RequestContext = {
      requestId: requestIdFromContext((key) => c.get(key)),
      method: c.req.method,
      url: c.req.url,
      route: `${route.method} ${route.path}`,
      audience: route.audience,
      scopes: route.scopes ?? [],
      ...(authorizationToken ? { authorizationToken } : {}),
      ...(c.req.raw.headers.get("traceparent") ? { traceparent: c.req.raw.headers.get("traceparent") ?? undefined } : {}),
    };

    c.set("requestContext", requestContext);

    if (route.identityContext === "none") {
      await next();
      return;
    }

    if (!authorizationToken) {
      throw new HTTPException(401, { message: "RequestContext authorization token is required" });
    }

    let identityContext: IdentityContext | null = null;

    if (route.identityContext === "dpop") {
      const proof = await verifyDpopProof(
        c.req.raw.headers,
        { method: c.req.method, url: c.req.url },
        authorizationToken,
      );
      if (!proof) {
        throw new HTTPException(401, {
          message: "IdentityContext DPoP proof is required and must be bound to RequestContext",
        });
      }
      identityContext = { proof: "dpop", dpop: proof };
    } else {
      const verifier = verifierFor(route.identityContext, verifiers);
      if (!verifier) {
        throw new HTTPException(501, {
          message: `IdentityContext verifier is not configured for ${route.identityContext}`,
        });
      }
      identityContext = await verifier({ request: c.req.raw, route, requestContext });
    }

    c.set("identityContext", identityContext);
    await next();
  };
}

const verifierFor = (
  requirement: IdentityContextRequirement,
  verifiers: IdentityContextVerifiers,
): IdentityContextVerifier | undefined => {
  switch (requirement) {
    case "client-instance":
      return verifiers.clientInstance;
    case "signed-webhook":
      return verifiers.signedWebhook;
    case "workload-proof":
      return verifiers.workloadProof;
    case "mtls":
      return verifiers.mtls;
    case "none":
    case "dpop":
      return undefined;
  }
};
