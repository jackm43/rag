import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";

import {
  ClientIdentityService,
  DiscoveryService,
  IdentityService,
  RegistryService,
  TraceService,
  type Application,
  type ExchangeTokenRequest,
  type ProviderConfig as ProviderConfigMessage,
} from "../../applications/idp/server/idp/v1/idp_pb";
import { calculateJwkThumbprint, createLocalJWKSet, jwtVerify, type JWK } from "jose";

import {
  accessOidcProvider,
  anyAuthenticator,
  bearerToken,
  logger,
  oidcAuthenticator,
  protect,
  requireIdentity,
  requireSenderConstraint,
  scopeMatches,
  stsAuthenticator,
  TOKEN_TYPE_ACCESS_TOKEN,
  TOKEN_TYPE_JWT,
  TOKEN_TYPE_SERVICE_CREDENTIAL,
  verifyDpopProof,
  actorChainFromClaim,
  verifyOidcToken,
  verifyStsToken,
  type Authenticator,
  type Identity,
  type RequestDescriptor,
} from "../../sdk/ts/src";
import { getJwks, signToken } from "./keys";
import {
  audit,
  createServiceClient,
  delegationFor,
  deleteApplication,
  getApplication,
  getApplicationByAudience,
  getProviderConfig,
  hasServiceClient,
  listApplications,
  listDelegations,
  setDelegations,
  upsertApplication,
  upsertProviderConfig,
  verifyServiceClient,
  type ApplicationAccess,
  type DelegationGrant,
  type ProviderConfig,
  type RegisteredApplication,
  type TrustBoundary,
} from "./registry";
import { consumeRefreshToken, createSession, revokeSession, type Session } from "./sessions";
import { getTrace, listTraces, streamSpans } from "./traces";
import { allowedEmails, type Env } from "./types";

const TOKEN_LIFETIME_SECONDS = 300;

const issuer = (env: Env) => env.GATEWAY_ISSUER.replace(/\/$/, "");

const jwksUrl = (env: Env) => `${issuer(env)}/.well-known/jwks.json`;

const oidcProvider = (env: Env) => accessOidcProvider(env.ACCESS_TEAM_DOMAIN, env.ACCESS_OIDC_CLIENT_ID);

// Completes an OIDC authorization-code + PKCE exchange against the identity
// proxy's token endpoint, server-side, and returns the upstream access token.
// Browser clients delegate this to the gateway because the proxy's token
// endpoint does not allow cross-origin (CORS) requests.
const exchangeAuthorizationCode = async (
  env: Env,
  request: { authorizationCode: string; codeVerifier: string; redirectUri: string },
): Promise<string> => {
  if (!request.codeVerifier || !request.redirectUri) {
    throw new ConnectError(
      "authorization_code requires code_verifier and redirect_uri",
      Code.InvalidArgument,
    );
  }
  const provider = oidcProvider(env);
  const response = await fetch(provider.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: request.authorizationCode,
      redirect_uri: request.redirectUri,
      client_id: provider.clientId,
      code_verifier: request.codeVerifier,
    }).toString(),
  });
  if (!response.ok) {
    throw new ConnectError(
      `upstream token exchange failed (${response.status})`,
      Code.Unauthenticated,
    );
  }
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new ConnectError("upstream token response had no access_token", Code.Unauthenticated);
  }
  return body.access_token;
};

export const isAllowedUser = (env: Env, identity: Identity): boolean =>
  identity.kind !== "user" ||
  (identity.email !== null && allowedEmails(env).includes(identity.email.toLowerCase()));

let localJwks: ReturnType<typeof createLocalJWKSet> | null = null;
let localJwksLoadedAt = 0;

const localSigningJwks = async (env: Env): Promise<ReturnType<typeof createLocalJWKSet> | null> => {
  const now = Date.now();
  if (!localJwks || now - localJwksLoadedAt > 60_000) {
    const response = await getJwks(env);
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { keys: Record<string, unknown>[] };
    localJwks = createLocalJWKSet(body);
    localJwksLoadedAt = now;
  }
  return localJwks;
};

const identityFromStsPayload = (payload: Record<string, unknown>): Identity | null => {
  if (typeof payload.sub !== "string") {
    return null;
  }
  const kind = payload.kind === "service" ? "service" : "user";
  const scopes = typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [];
  const cnf = payload.cnf as { jkt?: unknown } | undefined;
  return {
    kind,
    subject: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
    scopes,
    actorChain: actorChainFromClaim(payload.act),
    cnfJkt: typeof cnf?.jkt === "string" ? cnf.jkt : null,
    sessionId: typeof payload.sid === "string" ? payload.sid : null,
  };
};

const verifyLocalStsToken = async (
  env: Env,
  token: string,
  audience: string,
): Promise<Identity | null> => {
  const jwks = await localSigningJwks(env);
  if (!jwks) {
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: issuer(env),
      audience,
    });
    return identityFromStsPayload(payload as Record<string, unknown>);
  } catch {
    return null;
  }
};

const localGatewayStsAuthenticator = (env: Env): Authenticator => async (headers, request) => {
  const token = bearerToken(headers);
  if (!token) {
    return null;
  }
  const identity = await verifyLocalStsToken(env, token, "idp");
  return requireSenderConstraint(identity, headers, request);
};

export const gatewayAuthenticator = (env: Env): Authenticator =>
  anyAuthenticator(
    oidcAuthenticator(oidcProvider(env)),
    localGatewayStsAuthenticator(env),
    stsAuthenticator({ issuer: issuer(env), audience: "idp", jwksUrl: jwksUrl(env) }),
  );

const requestDescriptor = (context: HandlerContext): RequestDescriptor => ({
  method: context.requestMethod,
  url: context.url,
});

const requireDpopProof = async (context: HandlerContext): Promise<string> => {
  const proof = await verifyDpopProof(context.requestHeader, requestDescriptor(context));
  if (!proof) {
    throw new ConnectError("valid DPoP proof required", Code.Unauthenticated);
  }
  return proof.jkt;
};

const nestActChain = (chain: string[]): Record<string, unknown> | undefined => {
  let act: Record<string, unknown> | undefined;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    act = act ? { sub: chain[index], act } : { sub: chain[index] };
  }
  return act;
};

const delegationGrants = (delegation: DelegationGrant): string[] =>
  delegation.scopes.length > 0 ? delegation.scopes : [`${delegation.audience}/*`];

const trustBoundaryMessage = (boundary: TrustBoundary) => ({
  provider: boundary.provider,
  accountId: boundary.accountId,
  teamId: boundary.teamId,
  teamName: boundary.teamName,
  teamDomain: boundary.teamDomain,
});

const accessMessage = (access: ApplicationAccess) => ({
  allowedGroups: access.allowedGroups,
  allowedIdps: access.allowedIdps,
  postureRequired: access.postureRequired,
});

const applicationMessage = (app: RegisteredApplication, delegations: DelegationGrant[] = []): Application =>
  ({
    name: app.name,
    audience: app.audience,
    endpoint: app.endpoint,
    description: app.description,
    resources: app.resources,
    delegations,
    provider: app.provider,
    trustBoundary: trustBoundaryMessage(app.trustBoundary),
    access: accessMessage(app.access),
    trustZone: app.access.trustZone,
    impersonationAccessClientId: app.impersonationAccessClientId,
    createdAt: BigInt(app.createdAt),
    updatedAt: BigInt(app.updatedAt),
  }) as Application;

const organizationMessage = (policy: ProviderConfig["organization"]) => {
  if (!policy) {
    return undefined;
  }
  return {
    organization: policy.organization,
    zeroTrust: policy.zeroTrust,
    trustZones: policy.trustZones.map((zone) => ({
      name: zone.name,
      role: zone.role ?? "",
      description: zone.description ?? "",
      teamLabel: zone.teamLabel ?? "",
      groups: zone.groups ?? [],
      accessPolicy: zone.accessPolicy
        ? {
          approvalRequired: zone.accessPolicy.approvalRequired ?? false,
          purposeJustificationRequired: zone.accessPolicy.purposeJustificationRequired ?? false,
          sessionDuration: zone.accessPolicy.sessionDuration ?? "",
          isolationRequired: zone.accessPolicy.isolationRequired ?? false,
          requirePosture: zone.accessPolicy.requirePosture ?? false,
          mfaConfig: zone.accessPolicy.mfaConfig,
        }
        : undefined,
      enroll: zone.enroll,
    })),
  };
};

const providerConfigMessage = (config: ProviderConfig): ProviderConfigMessage =>
  ({
    boundary: trustBoundaryMessage(config.boundary),
    identityProviders: config.identityProviders.map((idp) => ({
      id: idp.id,
      name: idp.name,
      type: idp.type,
    })),
    groups: config.groups.map((group) => ({
      id: group.id,
      name: group.name,
    })),
    emailAllowlist: config.emailAllowlist,
    posture: {
      enabled: config.posture.enabled,
      ruleId: config.posture.ruleId,
      checks: config.posture.checks.map((check) => ({ type: check.type })),
    },
    organization: organizationMessage(config.organization),
  }) as ProviderConfigMessage;

const resolveSubject = async (
  env: Env,
  request: ExchangeTokenRequest,
  actorApplication: string | null,
): Promise<Identity | null> => {
  if (!request.subjectToken) {
    return null;
  }
  const tokenType = request.subjectTokenType || TOKEN_TYPE_ACCESS_TOKEN;

  if (tokenType === TOKEN_TYPE_ACCESS_TOKEN) {
    return verifyOidcToken(request.subjectToken, oidcProvider(env));
  }

  if (tokenType === TOKEN_TYPE_JWT) {
    // A chaining subject is normally a token addressed to the actor
    // application. A DPoP-bound gateway session token (aud "idp") is also
    // accepted: the actor app has already verified the sender constraint at
    // its own edge, and the issued token records the actor chain. This lets a
    // browser hold only its session and let apps mint their own audience
    // tokens server-side (backend-for-frontend exchange).
    const audiences = actorApplication ? [actorApplication, "idp"] : ["idp"];
    for (const audience of audiences) {
      const identity =
        (await verifyLocalStsToken(env, request.subjectToken, audience)) ??
        (await verifyStsToken(request.subjectToken, {
          issuer: issuer(env),
          audience,
          jwksUrl: jwksUrl(env),
        }));
      if (identity) {
        return identity;
      }
    }
    return null;
  }

  if (tokenType === TOKEN_TYPE_SERVICE_CREDENTIAL) {
    const separator = request.subjectToken.indexOf(":");
    if (separator < 0) {
      return null;
    }
    const application = await verifyServiceClient(
      env,
      request.subjectToken.slice(0, separator),
      request.subjectToken.slice(separator + 1),
    );
    if (!application) {
      return null;
    }
    const scopes = [`${application}/*`];
    for (const delegation of await listDelegations(env, application)) {
      scopes.push(...delegationGrants(delegation));
    }
    return {
      kind: "service",
      subject: request.subjectToken.slice(0, separator),
      email: null,
      scopes,
      actorChain: [],
    };
  }

  return null;
};

const validateScopes = (
  audience: string,
  requested: string[],
  granted: string[],
  fallback: string[],
): string[] => {
  const scopes = requested.length > 0 ? requested : fallback;
  for (const scope of scopes) {
    if (scope !== `${audience}/*` && !scope.startsWith(`${audience}/`)) {
      throw new ConnectError(`scope ${scope} is outside audience ${audience}`, Code.InvalidArgument);
    }
    if (!granted.some((grant) => scopeMatches(grant, scope))) {
      throw new ConnectError(`grant does not allow ${scope}`, Code.PermissionDenied);
    }
  }
  return scopes;
};

const sessionAccessToken = async (env: Env, session: Session): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    iss: issuer(env),
    sub: session.subject,
    aud: "idp",
    scope: "*",
    kind: "user",
    sid: session.id,
    cnf: { jkt: session.jkt },
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + TOKEN_LIFETIME_SECONDS,
  };
  if (session.email) {
    payload.email = session.email;
  }
  return signToken(env, payload);
};

const sessionTokensMessage = async (env: Env, session: Session, refreshToken: string) => ({
  accessToken: await sessionAccessToken(env, session),
  expiresIn: BigInt(TOKEN_LIFETIME_SECONDS),
  refreshToken,
  refreshExpiresIn: BigInt(Math.max(session.refreshExpiresAt - Math.floor(Date.now() / 1000), 0)),
  tokenType: "DPoP",
});

export const gatewayEndpoints = (env: Env) => {
  const base = issuer(env);
  return {
    tokenExchange: `${base}/idp.v1.IdentityService/ExchangeToken`,
    sessionCreate: `${base}/idp.v1.IdentityService/CreateSession`,
    sessionRefresh: `${base}/idp.v1.IdentityService/RefreshSession`,
    sessionRevoke: `${base}/idp.v1.IdentityService/RevokeSession`,
    introspect: `${base}/idp.v1.IdentityService/Introspect`,
    discovery: `${base}/api/discovery`,
    jwks: jwksUrl(env),
  };
};

export const registerServices = (router: ConnectRouter, env: Env) => {
  const authenticate = gatewayAuthenticator(env);
  const policy = {
    authenticate,
    allow: (identity: Identity) => isAllowedUser(env, identity),
  };

  router.service(IdentityService, {
    introspect: async (_request, context) => {
      const identity = await authenticate(context.requestHeader, requestDescriptor(context));
      if (!identity) {
        throw new ConnectError("unauthenticated", Code.Unauthenticated);
      }
      if (!isAllowedUser(env, identity)) {
        throw new ConnectError("forbidden", Code.PermissionDenied);
      }
      return {
        subject: identity.subject,
        email: identity.email ?? "",
        tokenKind: identity.kind,
        scopes: identity.scopes,
        actorChain: identity.actorChain,
      };
    },
    createSession: async (request, context) => {
      const jkt = await requireDpopProof(context);
      let subjectToken = request.subjectToken;
      if (request.authorizationCode) {
        // Server-side PKCE code exchange for browser clients (Module 3).
        subjectToken = await exchangeAuthorizationCode(env, request);
      } else if (request.subjectTokenType && request.subjectTokenType !== TOKEN_TYPE_ACCESS_TOKEN) {
        throw new ConnectError("sessions require an upstream access token", Code.InvalidArgument);
      }
      const identity = await verifyOidcToken(subjectToken, oidcProvider(env));
      if (!identity) {
        throw new ConnectError("invalid subject token", Code.Unauthenticated);
      }
      if (!isAllowedUser(env, identity)) {
        throw new ConnectError("forbidden", Code.PermissionDenied);
      }
      const { session, refreshToken } = await createSession(env, identity, jkt);
      await audit(env, identity.email ?? identity.subject, "session_created", session.id);
      logger.info("session_created", { subject: identity.subject, session: session.id });
      return { tokens: await sessionTokensMessage(env, session, refreshToken) };
    },
    refreshSession: async (request, context) => {
      const jkt = await requireDpopProof(context);
      if (!request.refreshToken) {
        throw new ConnectError("refresh_token is required", Code.InvalidArgument);
      }
      const rotated = await consumeRefreshToken(env, request.refreshToken, jkt);
      if (!rotated) {
        throw new ConnectError("invalid refresh token", Code.Unauthenticated);
      }
      await audit(
        env,
        rotated.session.email ?? rotated.session.subject,
        "session_refreshed",
        rotated.session.id,
      );
      logger.info("session_refreshed", { session: rotated.session.id });
      return { tokens: await sessionTokensMessage(env, rotated.session, rotated.refreshToken) };
    },
    revokeSession: async (request) => {
      if (!request.refreshToken) {
        throw new ConnectError("refresh_token is required", Code.InvalidArgument);
      }
      const revoked = await revokeSession(env, request.refreshToken);
      if (revoked) {
        logger.info("session_revoked", {});
      }
      return { revoked };
    },
    exchangeToken: async (request, context) => {
      let actorClientId: string | null = null;
      let actorApplication: string | null = null;
      if (request.actorToken) {
        if (request.actorTokenType && request.actorTokenType !== TOKEN_TYPE_SERVICE_CREDENTIAL) {
          throw new ConnectError("unsupported actor token type", Code.InvalidArgument);
        }
        const separator = request.actorToken.indexOf(":");
        if (separator < 0) {
          throw new ConnectError("invalid actor token", Code.Unauthenticated);
        }
        actorClientId = request.actorToken.slice(0, separator);
        actorApplication = await verifyServiceClient(
          env,
          actorClientId,
          request.actorToken.slice(separator + 1),
        );
        if (!actorApplication) {
          throw new ConnectError("invalid actor credential", Code.Unauthenticated);
        }
      }

      if (actorApplication) {
        const caller = await localGatewayStsAuthenticator(env)(
          context.requestHeader,
          requestDescriptor(context),
        );
        if (caller?.cnfJkt) {
          if (!request.impersonationToken) {
            throw new ConnectError("impersonation authorization required", Code.PermissionDenied);
          }
          const actorApp = await getApplication(env, actorApplication);
          if (!actorApp?.impersonationAccessClientId) {
            throw new ConnectError(
              `application ${actorApplication} has no impersonation access app configured`,
              Code.FailedPrecondition,
            );
          }
          const impersonation = await verifyOidcToken(
            request.impersonationToken,
            accessOidcProvider(env.ACCESS_TEAM_DOMAIN, actorApp.impersonationAccessClientId),
          );
          if (!impersonation) {
            throw new ConnectError("invalid impersonation token", Code.Unauthenticated);
          }
          if (
            !caller.email ||
            !impersonation.email ||
            impersonation.email.toLowerCase() !== caller.email.toLowerCase()
          ) {
            throw new ConnectError("impersonation token identity mismatch", Code.PermissionDenied);
          }
          await audit(
            env,
            caller.email ?? caller.subject,
            "impersonation_exchange",
            actorApplication,
          );
        }
      }

      const subject = await resolveSubject(env, request, actorApplication);
      if (!subject) {
        throw new ConnectError("invalid subject token", Code.Unauthenticated);
      }
      if (!isAllowedUser(env, subject)) {
        throw new ConnectError("forbidden", Code.PermissionDenied);
      }
      if (!actorApplication && subject.cnfJkt) {
        const jkt = await requireDpopProof(context);
        if (jkt !== subject.cnfJkt) {
          throw new ConnectError("DPoP proof does not match token binding", Code.Unauthenticated);
        }
      }

      const application = await getApplicationByAudience(env, request.audience);
      if (!application) {
        throw new ConnectError(`unknown audience ${request.audience}`, Code.NotFound);
      }

      let scopes: string[];
      if (actorApplication) {
        const delegation = await delegationFor(env, actorApplication, application.audience);
        if (!delegation) {
          throw new ConnectError(
            `application ${actorApplication} has no delegation to audience ${application.audience}`,
            Code.PermissionDenied,
          );
        }
        const granted = delegationGrants(delegation);
        scopes = validateScopes(application.audience, request.scopes, granted, granted);
      } else {
        scopes = validateScopes(application.audience, request.scopes, subject.scopes, [
          `${application.audience}/*`,
        ]);
      }

      const actorChain = actorClientId ? [actorClientId, ...subject.actorChain] : subject.actorChain;
      const now = Math.floor(Date.now() / 1000);
      const payload: Record<string, unknown> = {
        iss: issuer(env),
        sub: subject.subject,
        aud: application.audience,
        scope: scopes.join(" "),
        kind: subject.kind,
        jti: crypto.randomUUID(),
        iat: now,
        exp: now + TOKEN_LIFETIME_SECONDS,
      };
      if (subject.email) {
        payload.email = subject.email;
      }
      const act = nestActChain(actorChain);
      if (act) {
        payload.act = act;
      }

      const accessToken = await signToken(env, payload);
      logger.info("token_exchanged", {
        subject: subject.subject,
        audience: application.audience,
        actor: actorClientId ?? undefined,
        chained: actorApplication !== null,
      });
      return {
        accessToken,
        issuedTokenType: TOKEN_TYPE_JWT,
        tokenType: "Bearer",
        expiresIn: BigInt(TOKEN_LIFETIME_SECONDS),
        scopes,
      };
    },
  });

  router.service(
    RegistryService,
    protect(
      RegistryService,
      {
        registerApplication: async (request, context) => {
          try {
            const identity = requireIdentity(context);
            if (!request.name || !/^[a-z][a-z0-9-]*$/.test(request.name)) {
              throw new ConnectError("application name must be lowercase alphanumeric", Code.InvalidArgument);
            }
            for (const delegation of request.delegations) {
              if (!delegation.audience) {
                throw new ConnectError("delegation audience is required", Code.InvalidArgument);
              }
              for (const scope of delegation.scopes) {
                if (scope !== `${delegation.audience}/*` && !scope.startsWith(`${delegation.audience}/`)) {
                  throw new ConnectError(
                    `delegation scope ${scope} is outside audience ${delegation.audience}`,
                    Code.InvalidArgument,
                  );
                }
              }
            }
            const providerConfig = await getProviderConfig(env);
            const postureRequired =
              request.access?.postureRequired ?? (providerConfig.posture.enabled && providerConfig.posture.ruleId !== "");
          const application = await upsertApplication(env, {
            name: request.name,
            endpoint: request.endpoint,
            description: request.description,
            resources: request.resources.map((resource) => ({
              name: resource.name,
              methods: resource.methods.map((method) => ({
                name: method.name,
                scope: method.scope || `${request.name}/${resource.name}.${method.name}`,
              })),
            })),
            provider: request.provider ?? providerConfig.boundary.provider,
            trustBoundary: {
              provider: request.trustBoundary?.provider ?? providerConfig.boundary.provider,
              accountId: request.trustBoundary?.accountId ?? providerConfig.boundary.accountId,
              teamId: request.trustBoundary?.teamId ?? providerConfig.boundary.teamId,
              teamName: request.trustBoundary?.teamName ?? providerConfig.boundary.teamName,
              teamDomain: request.trustBoundary?.teamDomain ?? providerConfig.boundary.teamDomain,
            },
            access: {
              allowedGroups: request.access?.allowedGroups ?? [],
              allowedIdps: request.access?.allowedIdps ?? [],
              postureRequired,
              trustZone: request.trustZone || "tier2",
            },
            impersonationAccessClientId: request.impersonationAccessClientId ?? "",
          });
            const delegations = request.delegations.map((delegation) => ({
              audience: delegation.audience,
              scopes: delegation.scopes,
            }));
            await setDelegations(env, application.name, delegations);
            const credential = (await hasServiceClient(env, application.name))
              ? { clientId: "", clientSecret: "" }
              : await createServiceClient(env, application.name);
            await audit(
              env,
              identity.email ?? identity.subject,
              "register_application",
              application.name,
            );
            return {
              application: applicationMessage(application, delegations),
              credential,
            };
          } catch (error) {
            if (error instanceof ConnectError) {
              throw error;
            }
            logger.info("register_application_failed", { error: error instanceof Error ? error.message : String(error) });
            throw new ConnectError(
              error instanceof Error ? error.message : "register application failed",
              Code.Internal,
            );
          }
        },
        getApplication: async (request) => {
          const application = await getApplication(env, request.name);
          if (!application) {
            throw new ConnectError(`unknown application ${request.name}`, Code.NotFound);
          }
          return {
            application: applicationMessage(application, await listDelegations(env, application.name)),
          };
        },
        listApplications: async () => ({
          applications: await Promise.all(
            (await listApplications(env)).map(async (app) =>
              applicationMessage(app, await listDelegations(env, app.name)),
            ),
          ),
        }),
        deleteApplication: async (request, context) => {
          const identity = requireIdentity(context);
          const deleted = await deleteApplication(env, request.name);
          if (deleted) {
            await audit(env, identity.email ?? identity.subject, "delete_application", request.name);
          }
          return { deleted };
        },
        registerClient: async (request, context) => {
          const identity = requireIdentity(context);
          const application = await getApplication(env, request.application);
          if (!application) {
            throw new ConnectError(`unknown application ${request.application}`, Code.NotFound);
          }
          const credential = await createServiceClient(env, application.name);
          await audit(env, identity.email ?? identity.subject, "register_client", application.name);
          return { credential };
        },
        upsertProviderConfig: async (request, context) => {
          const identity = requireIdentity(context);
          let parsed: ProviderConfig;
          try {
            parsed = JSON.parse(request.configJson) as ProviderConfig;
          } catch {
            throw new ConnectError("config_json must be valid provider config JSON", Code.InvalidArgument);
          }
          const stored = await upsertProviderConfig(env, parsed);
          await audit(env, identity.email ?? identity.subject, "upsert_provider_config", stored.boundary.teamName);
          return { config: providerConfigMessage(stored) };
        },
        getProviderConfig: async () => ({
          config: providerConfigMessage(await getProviderConfig(env)),
        }),
      },
      policy,
    ),
  );

  // Tracing is an ordinary platform service: same Connect surface, protect()
  // policy, and generated clients as every other application RPC.
  router.service(
    TraceService,
    protect(
      TraceService,
      {
        listTraces: async (request) => ({
          traces: await listTraces(env, request.limit > 0 ? request.limit : 25),
        }),
        getTrace: async (request) => {
          const spans = await getTrace(env, request.traceId);
          if (!spans) {
            throw new ConnectError(`trace ${request.traceId} not found`, Code.NotFound);
          }
          return { traceId: request.traceId, spans };
        },
        // Live tail: poll the span store and stream new spans as they are
        // ingested. Streams are kept short (~45s) so idle connections are
        // recycled before intermediaries time them out; clients reconnect
        // continuously while the live view stays open.
        streamTraces: async function* (_request, context) {
          const POLL_MS = 1500;
          const MAX_TICKS = 30;
          let cursor = Math.floor(Date.now() / 1000) - 5;
          const seen = new Set<string>();
          for (let tick = 0; tick < MAX_TICKS && !context.signal.aborted; tick += 1) {
            const rows = await streamSpans(env, cursor);
            for (const row of rows) {
              if (seen.has(row.span.spanId)) {
                continue;
              }
              seen.add(row.span.spanId);
              cursor = Math.max(cursor, row.createdAt);
              yield { traceId: row.traceId, span: row.span };
            }
            if (seen.size > 4000) {
              seen.clear();
              cursor = Math.floor(Date.now() / 1000);
            }
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          }
        },
      },
      policy,
    ),
  );

  // Client identity registration: applications (acting for a user via a
  // chained token) register sub-identities — e.g. one chat conversation —
  // and receive a gateway-signed, key-bound identity document. This is the
  // IdP-registration surface; generated clients exist like any other service.
  router.service(
    ClientIdentityService,
    protect(
      ClientIdentityService,
      {
        registerClientIdentity: async (request, context) => {
          const identity = requireIdentity(context);
          const application = request.application.trim();
          if (!/^[a-z][a-z0-9-]*$/.test(application)) {
            throw new ConnectError("application must be a registered name", Code.InvalidArgument);
          }
          if (!(await getApplicationByAudience(env, application))) {
            throw new ConnectError(`unknown application ${application}`, Code.NotFound);
          }
          // The registering actor must be the application itself (chained
          // call) or the user directly (no actor chain).
          const lastActor = identity.actorChain[identity.actorChain.length - 1];
          if (lastActor && !lastActor.startsWith(`svc_${application}_`)) {
            throw new ConnectError(
              `actor ${lastActor} cannot register identities for ${application}`,
              Code.PermissionDenied,
            );
          }
          const instanceId = /^[A-Za-z0-9_-]{1,64}$/.test(request.instanceId)
            ? request.instanceId
            : crypto.randomUUID().replace(/-/g, "").slice(0, 16);
          let jkt = "";
          if (request.publicJwk) {
            try {
              jkt = await calculateJwkThumbprint(JSON.parse(request.publicJwk) as JWK, "sha256");
            } catch {
              throw new ConnectError("public_jwk is not a valid JWK", Code.InvalidArgument);
            }
          }
          const kind = request.kind.trim() || "client";
          const now = Math.floor(Date.now() / 1000);
          const expiresAt = now + TOKEN_LIFETIME_SECONDS * 144; // 12 hours
          await env.DB.prepare(
            `INSERT OR REPLACE INTO idp_client_identities
               (instance_id, application, subject, email, kind, jkt, public_jwk, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
            .bind(
              instanceId,
              application,
              identity.subject,
              identity.email ?? "",
              kind,
              jkt,
              request.publicJwk ?? "",
              now,
              expiresAt,
            )
            .run();
          const token = await signToken(env, {
            iss: issuer(env),
            sub: identity.subject,
            aud: application,
            email: identity.email ?? undefined,
            kind,
            instance: instanceId,
            iat: now,
            exp: expiresAt,
            jti: crypto.randomUUID(),
            ...(identity.actorChain.length > 0 ? { act: nestActChain(identity.actorChain) } : {}),
            ...(jkt ? { cnf: { jkt } } : {}),
          });
          await audit(
            env,
            identity.email ?? identity.subject,
            "register_client_identity",
            `${application}:${instanceId}`,
          );
          return {
            identityToken: token,
            expiresIn: BigInt(expiresAt - now),
            identity: {
              instanceId,
              application,
              subject: identity.subject,
              email: identity.email ?? "",
              kind,
              jkt,
              createdAt: BigInt(now),
              expiresAt: BigInt(expiresAt),
            },
          };
        },
        listClientIdentities: async (request) => {
          const application = request.application.trim();
          const rows = application
            ? await env.DB.prepare(
                "SELECT * FROM idp_client_identities WHERE application = ? ORDER BY created_at DESC LIMIT 100",
              )
                .bind(application)
                .run<Record<string, string | number>>()
            : await env.DB.prepare(
                "SELECT * FROM idp_client_identities ORDER BY created_at DESC LIMIT 100",
              ).run<Record<string, string | number>>();
          return {
            identities: rows.results.map((row) => ({
              instanceId: String(row.instance_id),
              application: String(row.application),
              subject: String(row.subject),
              email: String(row.email),
              kind: String(row.kind),
              jkt: String(row.jkt),
              createdAt: BigInt(row.created_at),
              expiresAt: BigInt(row.expires_at),
            })),
          };
        },
      },
      policy,
    ),
  );

  router.service(DiscoveryService, {
    discover: async () => buildDiscovery(env),
  });
};

export const buildDiscovery = async (env: Env) => {
  const oidc = oidcProvider(env);
  return {
    issuer: issuer(env),
    jwksUri: jwksUrl(env),
    oidc: {
      issuer: oidc.issuer,
      clientId: oidc.clientId,
      authorizationEndpoint: oidc.authorizationEndpoint,
      tokenEndpoint: oidc.tokenEndpoint,
      jwksEndpoint: oidc.jwksEndpoint,
    },
    endpoints: gatewayEndpoints(env),
    applications: await Promise.all(
      (await listApplications(env)).map(async (app) =>
        applicationMessage(app, await listDelegations(env, app.name)),
      ),
    ),
    provider: providerConfigMessage(await getProviderConfig(env)),
  };
};
