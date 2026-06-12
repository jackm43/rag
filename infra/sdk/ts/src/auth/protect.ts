import type { DescService } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";

import { hasScope, identityKey, type Identity } from "../identity";
import { logger } from "../logger";
import { annotateSpan } from "../otel";
import type { Authenticator } from "./authenticators";
import { clientInstance } from "./proxy";

export type AuthPolicy = {
  authenticate: Authenticator;
  allow?: (identity: Identity) => boolean;
  // Override the required scope per proto method name; return null to skip
  // the scope check for that method.
  scope?: (method: string) => string | null;
};

export const defaultScope = (service: DescService, method: string): string => {
  const segments = service.typeName.split(".");
  return `${segments[0]}/${segments[segments.length - 1]}.${method}`;
};

export const requireIdentity = (context: HandlerContext): Identity => {
  const identity = context.values.get(identityKey);
  if (!identity) {
    throw new ConnectError("unauthenticated", Code.Unauthenticated);
  }
  return identity;
};

export const protect = <S extends DescService>(
  service: S,
  implementation: ServiceImpl<S>,
  policy: AuthPolicy,
): ServiceImpl<S> => {
  const wrapped: Record<string, unknown> = {};
  for (const method of service.methods) {
    const handler = (implementation as Record<string, unknown>)[method.localName];
    if (typeof handler !== "function") {
      continue;
    }
    const scope = policy.scope ? policy.scope(method.name) : defaultScope(service, method.name);
    const methodName = `${service.typeName}/${method.name}`;
    // Identity-boundary standard: every inbound crossing is logged and
    // traced — successful authentications annotate the request span with the
    // verified identity, and refusals are logged with the reason.
    const authorize = async (context: HandlerContext) => {
      const identity = await policy.authenticate(context.requestHeader, {
        method: context.requestMethod,
        url: context.url,
      });
      if (!identity) {
        logger.warn("request_unauthenticated", { method: methodName });
        throw new ConnectError("unauthenticated", Code.Unauthenticated);
      }
      const actor = identity.email ?? identity.subject;
      if (policy.allow && !policy.allow(identity)) {
        logger.warn("request_denied", { method: methodName, actor, reason: "policy" });
        throw new ConnectError("forbidden", Code.PermissionDenied);
      }
      if (scope && !hasScope(identity, scope)) {
        logger.warn("request_denied", { method: methodName, actor, reason: "scope", scope });
        throw new ConnectError(`missing required scope ${scope}`, Code.PermissionDenied);
      }
      context.values.set(identityKey, identity);
      const instance = clientInstance(context.requestHeader);
      annotateSpan({
        actor,
        actor_kind: identity.kind,
        ...(identity.actorChain.length > 0 ? { actor_chain: identity.actorChain.join(" > ") } : {}),
        ...(identity.sessionId ? { session_id: identity.sessionId } : {}),
        ...(instance ? { client_instance: instance } : {}),
      });
      return identity;
    };
    if (method.methodKind === "server_streaming") {
      wrapped[method.localName] = async function* (request: unknown, context: HandlerContext) {
        const identity = await authorize(context);
        const start = Date.now();
        yield* (handler as (request: unknown, context: HandlerContext) => AsyncIterable<unknown>)(
          request,
          context,
        );
        // The request span ends at the response head; streams log their own
        // completion so the boundary records the full stream lifetime.
        logger.info("stream_completed", {
          method: methodName,
          actor: identity.email ?? identity.subject,
          duration_ms: Date.now() - start,
        });
      };
      continue;
    }
    wrapped[method.localName] = async (request: unknown, context: HandlerContext) => {
      await authorize(context);
      return (handler as (request: unknown, context: HandlerContext) => unknown)(request, context);
    };
  }
  return wrapped as ServiceImpl<S>;
};
