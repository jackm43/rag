import type { DescService } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";

import { hasScope, identityKey, type Identity } from "../identity";
import type { Authenticator } from "./authenticators";

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
    wrapped[method.localName] = async (request: unknown, context: HandlerContext) => {
      const identity = await policy.authenticate(context.requestHeader, {
        method: context.requestMethod,
        url: context.url,
      });
      if (!identity) {
        throw new ConnectError("unauthenticated", Code.Unauthenticated);
      }
      if (policy.allow && !policy.allow(identity)) {
        throw new ConnectError("forbidden", Code.PermissionDenied);
      }
      if (scope && !hasScope(identity, scope)) {
        throw new ConnectError(`missing required scope ${scope}`, Code.PermissionDenied);
      }
      context.values.set(identityKey, identity);
      return (handler as (request: unknown, context: HandlerContext) => unknown)(request, context);
    };
  }
  return wrapped as ServiceImpl<S>;
};
