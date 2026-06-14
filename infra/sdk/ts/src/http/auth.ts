import { HTTPException } from "hono/http-exception";
import type { MiddlewareHandler } from "hono";

import type { Authenticator } from "../auth/authenticators";
import { hasScope } from "../resource/scope";
import { annotateSpan } from "../otel/context";
import type { Identity } from "../identity";
import type { PlatformHonoVariables } from "./context";
import type { RouteContract } from "./types";

export interface PlatformHttpAuthVariables extends PlatformHonoVariables {
  identity?: Identity;
}

export function requirePlatformAuthorization<Bindings extends object = Record<string, never>>(
  route: RouteContract,
  authenticate: Authenticator,
): MiddlewareHandler<{ Bindings: Bindings; Variables: PlatformHttpAuthVariables }> {
  return async (c, next) => {
    if (route.auth === "none") {
      await next();
      return;
    }

    const identity = await authenticate(
      c.req.raw.headers,
      { method: c.req.method, url: c.req.url },
    );
    if (!identity) {
      throw new HTTPException(401, { message: "RequestContext authorization token is invalid" });
    }

    for (const scope of route.scopes ?? []) {
      if (!hasScope(identity, scope)) {
        throw new HTTPException(403, { message: `missing required scope ${scope}` });
      }
    }

    c.set("identity", identity);
    c.set("identityContext", {
      proof: route.identityContext,
      subject: identity.subject,
      actor: identity.actorChain[0],
      ...(identity.clientInstance ? { clientInstance: identity.clientInstance } : {}),
    });
    annotateSpan({
      ...(identity.clientInstance ? { client_instance: identity.clientInstance } : {}),
      ...(identity.clientKind ? { client_kind: identity.clientKind } : {}),
    });
    await next();
  };
}
