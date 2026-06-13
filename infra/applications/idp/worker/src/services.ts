import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";

import { ClientIdentityService } from "../../server/idp/v1/client_identity_service_pb";
import { DiscoveryService } from "../../server/idp/v1/gateway_discovery_service_pb";
import { IdentityService } from "../../server/idp/v1/identity_service_pb";
import { RegistryService } from "../../server/idp/v1/registry_service_pb";
import { TraceService } from "../../server/idp/v1/trace_service_pb";
import {
  type Application,
  type ProviderConfig as ProviderConfigMessage,
} from "../../server/idp/v1/types_pb";
import { calculateJwkThumbprint, type JWK } from "jose";

import {
  accessOidcProvider,
  anyAuthenticator,
  bearerToken,
  hasScope,
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
  verifyOidcToken,
  identityExchanged,
  identityExchangeRefused,
  principalFromIdentity,
  type Authenticator,
  type Identity,
  type RequestDescriptor,
} from "../../../../sdk/ts/src";
import { signToken } from "./keys";
import { verifyGatewayStsToken } from "./sts-verify";
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
  serviceClientApplication,
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
import { consumeRefreshToken, createSession, type Session } from "./sessions";
import { exchangeProviderAccessToken } from "./provider-oauth";
import { getTrace, listTraces, streamSpans } from "./traces";
import { allowedEmails, type Env } from "./types";

const TOKEN_LIFETIME_SECONDS = 300;

// Maximum actor chain length on an issued token, matching the verifier-side
// cap in the SDK (MAX_ACTOR_CHAIN_DEPTH).
const MAX_ACTOR_CHAIN = 8;

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
    redirect: "manual",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: request.authorizationCode,
      redirect_uri: request.redirectUri,
      client_id: provider.clientId,
      code_verifier: request.codeVerifier,
    }).toString(),
  });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") ?? "";
    throw new ConnectError(
      `upstream token exchange redirect (${response.status}): ${location}`,
      Code.Unauthenticated,
    );
  }
  if (!response.ok) {
    throw new ConnectError(
      `upstream token exchange failed (${response.status})`,
      Code.Unauthenticated,
    );
  }
  let body: { access_token?: string };
  try {
    body = (await response.json()) as { access_token?: string };
  } catch {
    throw new ConnectError("upstream token response was not JSON", Code.Unauthenticated);
  }
  if (!body.access_token) {
    throw new ConnectError("upstream token response had no access_token", Code.Unauthenticated);
  }
  return body.access_token;
};

export const isAllowedUser = (env: Env, identity: Identity): boolean =>
  identity.kind !== "user" ||
  (identity.email !== null && allowedEmails(env).includes(identity.email.toLowerCase()));

const localGatewayStsAuthenticator = (env: Env): Authenticator => async (headers, request) => {
  const token = bearerToken(headers);
  if (!token) {
    return null;
  }
  let identity = await verifyGatewayStsToken(env, token, "idp");
  if (identity) {
    identity = await requireValidActorChain(env, identity, "idp");
  }
  const constrained = await requireSenderConstraint(identity, headers, request);
  return constrained ? { ...constrained, subjectToken: token } : null;
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

const requireDpopProof = async (
  headers: Headers,
  request: RequestDescriptor,
  accessToken?: string,
): Promise<string> => {
  const proof = await verifyDpopProof(headers, request, accessToken);
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

// Re-validate a token's actor chain against the live registry. chain[0]
// minted the token addressed to `tokenAudience`; each deeper hop minted the
// token its predecessor consumed, whose audience was the predecessor's
// application (or a gateway session token, aud "idp"). Every hop must still
// map to a known service client whose application holds a delegation
// consistent with that position, so revoked delegations or deleted clients
// invalidate previously minted chains instead of being trusted forward.
// Returns a refusal reason, or null when the chain is valid.
const actorChainRefusal = async (
  env: Env,
  chain: string[],
  tokenAudience: string,
): Promise<string | null> => {
  if (chain.length === 0) {
    return null;
  }
  if (chain.length > MAX_ACTOR_CHAIN) {
    return `actor chain exceeds maximum depth ${MAX_ACTOR_CHAIN}`;
  }
  let candidates = [tokenAudience];
  for (const clientId of chain) {
    const application = await serviceClientApplication(env, clientId);
    if (!application) {
      return `unknown actor ${clientId} in chain`;
    }
    let delegated = false;
    for (const audience of candidates) {
      if (await delegationFor(env, application, audience)) {
        delegated = true;
        break;
      }
    }
    if (!delegated) {
      return `application ${application} has no delegation covering its position in the actor chain`;
    }
    candidates = application === "idp" ? ["idp"] : [application, "idp"];
  }
  return null;
};

const requireValidActorChain = async (
  env: Env,
  identity: Identity,
  tokenAudience: string,
): Promise<Identity | null> => {
  const refusal = await actorChainRefusal(env, identity.actorChain, tokenAudience);
  if (refusal) {
    logger.warn("actor_chain_rejected", {
      audience: tokenAudience,
      principal: principalFromIdentity(identity),
      reason: refusal,
    });
    return null;
  }
  return identity;
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
    providerOauthClientId: app.providerOauthClientId,
    providerOauthScopes: app.providerOauthScopes,
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

type ResolvedSubject = {
  identity: Identity;
  // The audience the subject token verified against; null for subjects that
  // are not gateway-issued tokens (upstream OIDC, service credentials).
  tokenAudience: string | null;
};

export type TokenExchangeInput = {
  subjectToken: string;
  subjectTokenType?: string;
  actorToken?: string;
  actorTokenType?: string;
  audience: string;
  scopes: string[];
  requestedTokenType?: string;
  impersonationToken?: string;
  impersonationTokenType?: string;
};

export type TokenExchangeOutput = {
  accessToken: string;
  issuedTokenType: string;
  tokenType: string;
  expiresIn: bigint;
  scopes: string[];
};

export type GatewaySessionGrantInput = {
  subjectToken?: string;
  subjectTokenType?: string;
  authorizationCode?: string;
  codeVerifier?: string;
  redirectUri?: string;
};

export type GatewayRefreshGrantInput = {
  refreshToken?: string;
};

export type GatewaySessionTokens = {
  accessToken: string;
  expiresIn: bigint;
  refreshToken: string;
  refreshExpiresIn: bigint;
  tokenType: string;
};

const resolveSubject = async (
  env: Env,
  request: TokenExchangeInput,
  actorApplication: string | null,
): Promise<ResolvedSubject | null> => {
  if (!request.subjectToken) {
    return null;
  }
  const tokenType = request.subjectTokenType || TOKEN_TYPE_ACCESS_TOKEN;

  // Chained exchanges forward a caller identity: the subject must be a
  // gateway-issued token addressed to the actor application (or a session
  // token), so a service can never replay an unbound upstream credential
  // through its delegations.
  if (actorApplication && tokenType !== TOKEN_TYPE_JWT) {
    throw new ConnectError(
      "chained exchange requires a gateway-issued subject token",
      Code.InvalidArgument,
    );
  }

  if (tokenType === TOKEN_TYPE_ACCESS_TOKEN) {
    const identity = await verifyOidcToken(request.subjectToken, oidcProvider(env));
    return identity ? { identity, tokenAudience: null } : null;
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
      const identity = await verifyGatewayStsToken(env, request.subjectToken, audience);
      if (identity) {
        return { identity, tokenAudience: audience };
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
      identity: {
        kind: "service",
        subject: request.subjectToken.slice(0, separator),
        email: null,
        scopes,
        actorChain: [],
      },
      tokenAudience: null,
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

const sessionTokensMessage = async (
  env: Env,
  session: Session,
  refreshToken: string,
): Promise<GatewaySessionTokens> => ({
  accessToken: await sessionAccessToken(env, session),
  expiresIn: BigInt(TOKEN_LIFETIME_SECONDS),
  refreshToken,
  refreshExpiresIn: BigInt(Math.max(session.refreshExpiresAt - Math.floor(Date.now() / 1000), 0)),
  tokenType: "DPoP",
});

export const createGatewaySession = async (
  env: Env,
  request: GatewaySessionGrantInput,
  dpopJkt: string,
): Promise<GatewaySessionTokens> => {
  let subjectToken = request.subjectToken ?? "";
  if (request.authorizationCode) {
    // Server-side PKCE code exchange for browser clients.
    subjectToken = await exchangeAuthorizationCode(env, {
      authorizationCode: request.authorizationCode,
      codeVerifier: request.codeVerifier ?? "",
      redirectUri: request.redirectUri ?? "",
    });
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
  const { session, refreshToken } = await createSession(env, identity, dpopJkt);
  await audit(env, identity.email ?? identity.subject, "session_created", session.id);
  logger.info("session_created", { subject: identity.subject, session: session.id });
  return sessionTokensMessage(env, session, refreshToken);
};

export const refreshGatewaySession = async (
  env: Env,
  request: GatewayRefreshGrantInput,
  dpopJkt: string,
): Promise<GatewaySessionTokens> => {
  if (!request.refreshToken) {
    throw new ConnectError("refresh_token is required", Code.InvalidArgument);
  }
  const rotated = await consumeRefreshToken(env, request.refreshToken, dpopJkt);
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
  return sessionTokensMessage(env, rotated.session, rotated.refreshToken);
};

export type TokenExchangeContext = {
  headers: Headers;
  request: RequestDescriptor;
};

export const exchangeGatewayToken = async (
  env: Env,
  request: TokenExchangeInput,
  context: TokenExchangeContext,
): Promise<TokenExchangeOutput> => {
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
    const caller = await localGatewayStsAuthenticator(env)(context.headers, context.request);
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

  const resolved = await resolveSubject(env, request, actorApplication);
  if (!resolved) {
    throw new ConnectError("invalid subject token", Code.Unauthenticated);
  }
  const subject = resolved.identity;
  if (!isAllowedUser(env, subject)) {
    throw new ConnectError("forbidden", Code.PermissionDenied);
  }
  if (!actorApplication && subject.cnfJkt) {
    const jkt = await requireDpopProof(context.headers, context.request, request.subjectToken);
    if (jkt !== subject.cnfJkt) {
      throw new ConnectError("DPoP proof does not match token binding", Code.Unauthenticated);
    }
  }

  // An inherited actor chain is only ever trusted after re-validation
  // against the live registry: every prior hop must still be a known
  // service client with a delegation matching its position in the chain.
  if (subject.actorChain.length > 0 && resolved.tokenAudience) {
    const refusal = await actorChainRefusal(env, subject.actorChain, resolved.tokenAudience);
    if (refusal) {
      identityExchangeRefused({
        audience: request.audience,
        subject_token_type: request.subjectTokenType ?? "",
        ...(request.actorTokenType ? { actor_token_type: request.actorTokenType } : {}),
        ...(actorClientId ? { act: actorClientId } : {}),
        ...(request.impersonationToken ? { impersonation: true } : {}),
        principal: principalFromIdentity(subject),
        reason: refusal,
      });
      await audit(env, subject.email ?? subject.subject, "exchange_chain_refused", refusal);
      throw new ConnectError(refusal, Code.PermissionDenied);
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
  if (actorChain.length > MAX_ACTOR_CHAIN) {
    throw new ConnectError(
      `actor chain exceeds maximum depth ${MAX_ACTOR_CHAIN}`,
      Code.PermissionDenied,
    );
  }
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
  identityExchanged({
    audience: application.audience,
    subject_token_type: request.subjectTokenType ?? "",
    ...(request.actorTokenType ? { actor_token_type: request.actorTokenType } : {}),
    ...(actorClientId ? { act: actorClientId } : {}),
    ...(request.impersonationToken ? { impersonation: true } : {}),
    principal: principalFromIdentity({
      kind: subject.kind,
      subject: subject.subject,
      email: subject.email,
      actorChain,
    }),
    scopes,
  });
  return {
    accessToken,
    issuedTokenType: TOKEN_TYPE_JWT,
    tokenType: "Bearer",
    expiresIn: BigInt(TOKEN_LIFETIME_SECONDS),
    scopes,
  };
};

export const gatewayEndpoints = (env: Env) => {
  const base = issuer(env);
  return {
    tokenExchange: `${base}/oauth/token`,
    tokenRevoke: `${base}/oauth/revoke`,
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
        logger.warn("request_unauthenticated", { method: "idp.v1.IdentityService/Introspect" });
        throw new ConnectError("unauthenticated", Code.Unauthenticated);
      }
      if (!isAllowedUser(env, identity)) {
        throw new ConnectError("forbidden", Code.PermissionDenied);
      }
      const scope = "idp/IdentityService.Introspect";
      if (!hasScope(identity, scope)) {
        logger.warn("request_denied", {
          method: "idp.v1.IdentityService/Introspect",
          actor: identity.email ?? identity.subject,
          reason: "scope",
          scope,
        });
        throw new ConnectError(`missing required scope ${scope}`, Code.PermissionDenied);
      }
      const principal = principalFromIdentity(identity);
      return {
        principal: {
          kind: principal.kind,
          sub: principal.sub,
          email: principal.email ?? "",
          act: principal.act ?? [],
        },
        scopes: identity.scopes,
      };
    },
    exchangeProviderToken: async (request, context) => {
      const auth = context.requestHeader.get("authorization") ?? "";
      const subjectToken = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : request.subjectToken;
      if (!subjectToken) {
        throw new ConnectError("subject token is required", Code.Unauthenticated);
      }
      if (!request.application) {
        throw new ConnectError("application is required", Code.InvalidArgument);
      }
      const exchanged = await exchangeProviderAccessToken(env, subjectToken, request.application);
      if (!exchanged.accessToken) {
        return {
          accessToken: "",
          expiresIn: 0n,
          authorizeUrl: exchanged.authorizeUrl ?? "",
        };
      }
      return {
        accessToken: exchanged.accessToken,
        expiresIn: BigInt(exchanged.expiresIn),
        authorizeUrl: "",
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
              providerOauthClientId: request.providerOauthClientId ?? "",
              providerOauthScopes: request.providerOauthScopes ?? [],
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
          // call) or the user directly (no actor chain). The immediate actor
          // is the head of the chain: the service that performed this hop.
          const immediateActor = identity.actorChain[0];
          if (immediateActor && !immediateActor.startsWith(`svc_${application}_`)) {
            throw new ConnectError(
              `actor ${immediateActor} cannot register identities for ${application}`,
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
        listClientIdentities: async (request, context) => {
          const identity = requireIdentity(context);
          const application = request.application.trim();
          // A chained caller may only list identities for the application
          // that performed the hop; the unscoped listing is reserved for
          // direct (allowlisted) users.
          const immediateActor = identity.actorChain[0];
          if (immediateActor) {
            if (!application || !immediateActor.startsWith(`svc_${application}_`)) {
              throw new ConnectError(
                `actor ${immediateActor} may only list identities for its own application`,
                Code.PermissionDenied,
              );
            }
          }
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

export const buildBootstrapDiscovery = (env: Env) => {
  const oidc = oidcProvider(env);
  return {
    oidc: {
      issuer: oidc.issuer,
      clientId: oidc.clientId,
      authorizationEndpoint: oidc.authorizationEndpoint,
      tokenEndpoint: oidc.tokenEndpoint,
      jwksEndpoint: oidc.jwksEndpoint,
    },
    endpoints: gatewayEndpoints(env),
  };
};

export const buildDiscovery = async (env: Env) => {
  const bootstrap = buildBootstrapDiscovery(env);
  return {
    issuer: issuer(env),
    jwksUri: jwksUrl(env),
    ...bootstrap,
    applications: await Promise.all(
      (await listApplications(env)).map(async (app) =>
        applicationMessage(app, await listDelegations(env, app.name)),
      ),
    ),
    provider: providerConfigMessage(await getProviderConfig(env)),
  };
};

export const buildAuthorizationServerMetadata = async (env: Env) => {
  const discovered = await buildDiscovery(env);
  const scopes = new Set<string>(["openid", "email", "profile", "*"]);
  for (const app of discovered.applications) {
    for (const resource of app.resources) {
      for (const method of resource.methods) {
        if (method.scope) {
          scopes.add(method.scope);
        }
      }
    }
    scopes.add(`${app.audience}/*`);
  }
  return {
    issuer: discovered.issuer,
    authorization_endpoint: discovered.oidc.authorizationEndpoint,
    token_endpoint: discovered.endpoints.tokenExchange,
    jwks_uri: discovered.jwksUri,
    introspection_endpoint: discovered.endpoints.introspect,
    revocation_endpoint: discovered.endpoints.tokenRevoke,
    response_types_supported: ["code"],
    grant_types_supported: [
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:token-exchange",
    ],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: Array.from(scopes).sort(),
    token_endpoint_auth_signing_alg_values_supported: ["ES256"],
    id_token_signing_alg_values_supported: ["ES256"],
    dpop_signing_alg_values_supported: ["ES256"],
    subject_types_supported: ["public"],
    claims_supported: ["iss", "sub", "aud", "exp", "iat", "jti", "email", "scope", "act", "cnf", "sid"],
    service_documentation: `${discovered.issuer}/api/discovery`,
    platy_discovery_endpoint: discovered.endpoints.discovery,
  };
};
