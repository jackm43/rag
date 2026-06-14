import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { logger as honoLogger } from "hono/logger";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";

import { REQUEST_ID_HEADER } from "./request";
import { requestCompletedLog, type StructuredLogSink } from "./logger";
import { DEFAULT_PLATFORM_SECURITY_POLICY } from "./security";
import type { PlatformHonoVariables } from "./context";

export interface PlatformHonoConfig {
  application: string;
  logger?: StructuredLogSink;
  csrfOrigins?: string[];
}

export type PlatformHonoEnv<Bindings extends object = Record<string, never>> = {
  Bindings: Bindings;
  Variables: PlatformHonoVariables;
};

export function createPlatformHonoApp<Bindings extends object = Record<string, never>>(
  config: PlatformHonoConfig,
): Hono<PlatformHonoEnv<Bindings>> {
  const app = new Hono<PlatformHonoEnv<Bindings>>();
  const log = config.logger ?? ((event) => console.log(JSON.stringify(event)));

  app.use("*", requestId({ headerName: REQUEST_ID_HEADER }));
  app.use("*", honoLogger((message, ...rest) => {
    console.log(message, ...rest);
  }));
  app.use("*", async (c, next) => {
    const startedAt = Date.now();
    await next();
    const requestContext = c.get("requestContext");
    const identityContext = c.get("identityContext");
    log(requestCompletedLog({
      requestId: c.get("requestId"),
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      startedAt,
      ...(requestContext?.traceparent ? { traceId: requestContext.traceparent } : {}),
      ...(identityContext?.subject ? { subject: identityContext.subject } : {}),
      ...(identityContext?.actor ? { actor: identityContext.actor } : {}),
      ...(requestContext?.audience ? { audience: requestContext.audience } : {}),
      ...(requestContext?.route ? { route: requestContext.route } : {}),
    }));
  });
  app.use("*", secureHeaders({
    contentSecurityPolicy: mutableCsp(DEFAULT_PLATFORM_SECURITY_POLICY.secureHeaders.contentSecurityPolicy),
    strictTransportSecurity: DEFAULT_PLATFORM_SECURITY_POLICY.secureHeaders.strictTransportSecurity,
    xContentTypeOptions: DEFAULT_PLATFORM_SECURITY_POLICY.secureHeaders.xContentTypeOptions,
    xFrameOptions: DEFAULT_PLATFORM_SECURITY_POLICY.secureHeaders.xFrameOptions,
    referrerPolicy: DEFAULT_PLATFORM_SECURITY_POLICY.secureHeaders.referrerPolicy,
  }));
  app.use("*", csrf({
    ...(config.csrfOrigins ? { origin: config.csrfOrigins } : {}),
    secFetchSite: ["same-origin", "same-site", "none"],
  }));

  return app;
}

const mutableCsp = (
  csp: Record<string, readonly string[]>,
): Record<string, string[]> =>
  Object.fromEntries(
    Object.entries(csp).map(([key, value]) => [key, [...value]]),
  );
