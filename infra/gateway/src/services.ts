import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";

import {
  DiscoveryService,
  IdentityService,
  RegistryService,
  type Application,
  type ExchangeTokenRequest,
  type ProviderConfig as ProviderConfigMessage,
} from "../../applications/idp/server/idp/v1/idp_pb";
import {
  accessOidcProvider,
  anyAuthenticator,
  logger,
  oidcAuthenticator,
  protect,
  requireIdentity,
  scopeMatches,
  stsAuthenticator,
  TOKEN_TYPE_ACCESS_TOKEN,
  TOKEN_TYPE_JWT,
  TOKEN_TYPE_SERVICE_CREDENTIAL,
  verifyDpopProof,
  verifyOidcToken,
  verifyStsToken,
  type Authenticator,
  type Identity,
  type RequestDescriptor,
} from "../../sdk/ts/src";
import { signToken } from "./keys";
import {
  audit,
  createServiceClient,
  delegationFor,
  deleteApplication,
  getApplication,
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
import { allowedEmails, type Env } from "./types";

const TOKEN_LIFETIME_SECONDS = 300;

const issuer = (env: Env) => env.GATEWAY_ISSUER.replace(/\/$/, "");

const jwksUrl = (env: Env) => `${issuer(env)}/.well-known/jwks.json`;

const oidcProvider = (env: Env) => accessOidcProvider(env.ACCESS_TEAM_DOMAIN, env.ACCESS_OIDC_CLIENT_ID);

const isAllowedUser = (env: Env, identity: Identity): boolean =>
  identity.kind !== "user" ||
  (identity.email !== null && allowedEmails(env).includes(identity.email.toLowerCase()));

const gatewayAuthenticator = (env: Env): Authenticator =>
  anyAuthenticator(
    oidcAuthenticator(oidcProvider(env)),
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
    return verifyStsToken(request.subjectToken, {
      issuer: issuer(env),
      audience: actorApplication ?? "idp",
      jwksUrl: jwksUrl(env),
    });
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
    whoAmI: `${base}/idp.v1.IdentityService/WhoAmI`,
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
    whoAmI: async (_request, context) => {
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
      if (request.subjectTokenType && request.subjectTokenType !== TOKEN_TYPE_ACCESS_TOKEN) {
        throw new ConnectError("sessions require an upstream access token", Code.InvalidArgument);
      }
      const identity = await verifyOidcToken(request.subjectToken, oidcProvider(env));
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

      const application = await getApplication(env, request.audience);
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
