import { OAuthError, OAuthErrorCode } from "./oauth-error";

import {
  accessOidcProvider,
  anyAuthenticator,
  bearerToken,
  directExchangeGrants,
  hasScope,
  isCommunitySession,
  logger,
  oidcAuthenticator,
  requireSenderConstraint,
  scopeMatches,
  sessionScopeForTier,
  sessionTierFromScope,
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
} from "@platy/sdk";
import { signToken } from "./keys";
import { verifyGatewayStsToken, verifyGatewayTokenClaims } from "./sts-verify";
import {
  audit,
  delegationFor,
  getApplication,
  getApplicationByAudience,
  getProviderConfig,
  listApplications,
  listDelegations,
  serviceClientApplication,
  verifyServiceClient,
  type ApplicationAccess,
  type DelegationGrant,
  type ProviderConfig,
  type RegisteredApplication,
  type TrustBoundary,
} from "./registry";
import { consumeRefreshToken, createSession, type Session } from "./sessions";
import { isInternalEmail, type Env } from "./types";
import { DISCORD_CODE_PREFIX, discordAuthorizeUrl, redeemDiscordCode } from "./discord-oauth";

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
    throw new OAuthError(
      "authorization_code requires code_verifier and redirect_uri",
      OAuthErrorCode.InvalidArgument,
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
    throw new OAuthError(
      `upstream token exchange redirect (${response.status}): ${location}`,
      OAuthErrorCode.Unauthenticated,
    );
  }
  if (!response.ok) {
    throw new OAuthError(
      `upstream token exchange failed (${response.status})`,
      OAuthErrorCode.Unauthenticated,
    );
  }
  let body: { access_token?: string };
  try {
    body = (await response.json()) as { access_token?: string };
  } catch {
    throw new OAuthError("upstream token response was not JSON", OAuthErrorCode.Unauthenticated);
  }
  if (!body.access_token) {
    throw new OAuthError("upstream token response had no access_token", OAuthErrorCode.Unauthenticated);
  }
  return body.access_token;
};

export const isAllowedUser = (env: Env, identity: Identity): boolean => {
  if (identity.kind !== "user") {
    return true;
  }
  const tier = sessionTierFromScope(identity.scopes);
  if (tier === "community") {
    return true;
  }
  return isInternalEmail(env, identity.email);
};

export const allowGatewayPrincipal = (env: Env, identity: Identity): boolean => {
  if (!isAllowedUser(env, identity)) {
    return false;
  }
  if (isCommunitySession(identity) && identity.cnfJkt) {
    return false;
  }
  return true;
};

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

const requireDpopProof = async (
  headers: Headers,
  request: RequestDescriptor,
  accessToken?: string,
): Promise<string> => {
  const proof = await verifyDpopProof(headers, request, accessToken);
  if (!proof) {
    throw new OAuthError("valid DPoP proof required", OAuthErrorCode.Unauthenticated);
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

export const applicationView = (app: RegisteredApplication, delegations: DelegationGrant[] = []) => ({
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
  createdAt: app.createdAt,
  updatedAt: app.updatedAt,
});

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

export const providerConfigView = (config: ProviderConfig) => ({
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
});

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
  scope: string;
};

// User sessions carry a trust-tier scope (internal or community), not a
// platform wildcard. Tier rules govern token exchange and gateway RPC access.

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
    throw new OAuthError(
      "chained exchange requires a gateway-issued subject token",
      OAuthErrorCode.InvalidArgument,
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
      throw new OAuthError(`scope ${scope} is outside audience ${audience}`, OAuthErrorCode.InvalidArgument);
    }
    if (!granted.some((grant) => scopeMatches(grant, scope))) {
      throw new OAuthError(`grant does not allow ${scope}`, OAuthErrorCode.PermissionDenied);
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
    scope: sessionScopeForTier(session.tier),
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
  scope: sessionScopeForTier(session.tier),
});

export const createGatewaySession = async (
  env: Env,
  request: GatewaySessionGrantInput,
  dpopJkt: string,
): Promise<GatewaySessionTokens> => {
  if (request.authorizationCode?.startsWith(DISCORD_CODE_PREFIX)) {
    const redeemed = await redeemDiscordCode(env, {
      authorizationCode: request.authorizationCode,
      codeVerifier: request.codeVerifier ?? "",
      redirectUri: request.redirectUri ?? "",
    });
    const identity: Identity = {
      kind: "user",
      subject: redeemed.subject,
      email: null,
      scopes: ["community"],
      actorChain: [],
    };
    return createCommunityGatewaySession(env, identity, dpopJkt);
  }
  let subjectToken = request.subjectToken ?? "";
  if (request.authorizationCode) {
    // Server-side PKCE code exchange for browser clients.
    subjectToken = await exchangeAuthorizationCode(env, {
      authorizationCode: request.authorizationCode,
      codeVerifier: request.codeVerifier ?? "",
      redirectUri: request.redirectUri ?? "",
    });
  } else if (request.subjectTokenType && request.subjectTokenType !== TOKEN_TYPE_ACCESS_TOKEN) {
    throw new OAuthError("sessions require an upstream access token", OAuthErrorCode.InvalidArgument);
  }
  const identity = await verifyOidcToken(subjectToken, oidcProvider(env));
  if (!identity) {
    throw new OAuthError("invalid subject token", OAuthErrorCode.Unauthenticated);
  }
  if (!isInternalEmail(env, identity.email)) {
    throw new OAuthError("forbidden", OAuthErrorCode.PermissionDenied);
  }
  const { session, refreshToken } = await createSession(env, identity, dpopJkt, "internal");
  await audit(env, identity.email ?? identity.subject, "session_created", session.id);
  logger.info("session_created", { subject: identity.subject, session: session.id });
  return sessionTokensMessage(env, session, refreshToken);
};

export const createCommunityGatewaySession = async (
  env: Env,
  identity: Identity,
  dpopJkt: string,
): Promise<GatewaySessionTokens> => {
  const { session, refreshToken } = await createSession(env, identity, dpopJkt, "community");
  await audit(env, identity.email ?? identity.subject, "session_created", session.id);
  logger.info("session_created", { subject: identity.subject, session: session.id, tier: "community" });
  return sessionTokensMessage(env, session, refreshToken);
};

export const refreshGatewaySession = async (
  env: Env,
  request: GatewayRefreshGrantInput,
  dpopJkt: string,
): Promise<GatewaySessionTokens> => {
  if (!request.refreshToken) {
    throw new OAuthError("refresh_token is required", OAuthErrorCode.InvalidArgument);
  }
  const rotated = await consumeRefreshToken(env, request.refreshToken, dpopJkt);
  if (!rotated) {
    throw new OAuthError("invalid refresh token", OAuthErrorCode.Unauthenticated);
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
      throw new OAuthError("unsupported actor token type", OAuthErrorCode.InvalidArgument);
    }
    const separator = request.actorToken.indexOf(":");
    if (separator < 0) {
      throw new OAuthError("invalid actor token", OAuthErrorCode.Unauthenticated);
    }
    actorClientId = request.actorToken.slice(0, separator);
    actorApplication = await verifyServiceClient(
      env,
      actorClientId,
      request.actorToken.slice(separator + 1),
    );
    if (!actorApplication) {
      throw new OAuthError("invalid actor credential", OAuthErrorCode.Unauthenticated);
    }
  }

  if (actorApplication) {
    const caller = await localGatewayStsAuthenticator(env)(context.headers, context.request);
    if (caller?.cnfJkt) {
      if (!request.impersonationToken) {
        throw new OAuthError("impersonation authorization required", OAuthErrorCode.PermissionDenied);
      }
      const actorApp = await getApplication(env, actorApplication);
      if (!actorApp?.impersonationAccessClientId) {
        throw new OAuthError(
          `application ${actorApplication} has no impersonation access app configured`,
          OAuthErrorCode.FailedPrecondition,
        );
      }
      const impersonation = await verifyOidcToken(
        request.impersonationToken,
        accessOidcProvider(env.ACCESS_TEAM_DOMAIN, actorApp.impersonationAccessClientId),
      );
      if (!impersonation) {
        throw new OAuthError("invalid impersonation token", OAuthErrorCode.Unauthenticated);
      }
      if (
        !caller.email ||
        !impersonation.email ||
        impersonation.email.toLowerCase() !== caller.email.toLowerCase()
      ) {
        throw new OAuthError("impersonation token identity mismatch", OAuthErrorCode.PermissionDenied);
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
    throw new OAuthError("invalid subject token", OAuthErrorCode.Unauthenticated);
  }
  const subject = resolved.identity;
  if (!isAllowedUser(env, subject)) {
    throw new OAuthError("forbidden", OAuthErrorCode.PermissionDenied);
  }
  if (!actorApplication && subject.cnfJkt) {
    const jkt = await requireDpopProof(context.headers, context.request, request.subjectToken);
    if (jkt !== subject.cnfJkt) {
      throw new OAuthError("DPoP proof does not match token binding", OAuthErrorCode.Unauthenticated);
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
      throw new OAuthError(refusal, OAuthErrorCode.PermissionDenied);
    }
  }

  const application = await getApplicationByAudience(env, request.audience);
  if (!application) {
    throw new OAuthError(`unknown audience ${request.audience}`, OAuthErrorCode.NotFound);
  }

  let scopes: string[];
  if (actorApplication) {
    const delegation = await delegationFor(env, actorApplication, application.audience);
    if (!delegation) {
      throw new OAuthError(
        `application ${actorApplication} has no delegation to audience ${application.audience}`,
        OAuthErrorCode.PermissionDenied,
      );
    }
    const granted = delegationGrants(delegation);
    scopes = validateScopes(application.audience, request.scopes, granted, granted);
  } else {
    if (isCommunitySession(subject)) {
      throw new OAuthError("community sessions require an actor token", OAuthErrorCode.PermissionDenied);
    }
    const grants = directExchangeGrants(subject, application.audience);
    if (!grants) {
      throw new OAuthError("community sessions require an actor token", OAuthErrorCode.PermissionDenied);
    }
    scopes = validateScopes(application.audience, request.scopes, grants, [
      `${application.audience}/*`,
    ]);
  }

  const actorChain = actorClientId ? [actorClientId, ...subject.actorChain] : subject.actorChain;
  if (actorChain.length > MAX_ACTOR_CHAIN) {
    throw new OAuthError(
      `actor chain exceeds maximum depth ${MAX_ACTOR_CHAIN}`,
      OAuthErrorCode.PermissionDenied,
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
  if (subject.clientInstance) {
    payload.instance = subject.clientInstance;
  }
  if (subject.clientKind) {
    payload.client_kind = subject.clientKind;
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
    introspect: `${base}/oauth/introspect`,
    discovery: `${base}/api/discovery`,
    jwks: jwksUrl(env),
  };
};

export const INTROSPECTION_SCOPE = "idp/IdentityService.Introspect";

// RFC 7662 introspection of a presented token. The caller is authenticated and
// scope-checked by the HTTP handler; here we verify the gateway signature and
// shape the standard response. An invalid, expired, or foreign token is simply
// inactive rather than an error.
export const introspectToken = async (
  env: Env,
  token: string,
): Promise<Record<string, unknown>> => {
  const claims = token ? await verifyGatewayTokenClaims(env, token) : null;
  if (!claims) {
    return { active: false };
  }
  const cnf = claims.cnf as { jkt?: unknown } | undefined;
  const response: Record<string, unknown> = {
    active: true,
    token_type: cnf?.jkt ? "DPoP" : "Bearer",
  };
  const copy = (key: string) => {
    if (claims[key] !== undefined) {
      response[key] = claims[key];
    }
  };
  for (const key of ["sub", "aud", "iss", "exp", "iat", "scope", "jti", "email", "sid", "act", "cnf", "kind"]) {
    copy(key);
  }
  return response;
};

// Caller authentication for the introspection endpoint: a gateway-issued token
// (audience idp) belonging to an allowed user with the introspect scope.
export const authorizeIntrospectionCaller = async (
  env: Env,
  headers: Headers,
  request: RequestDescriptor,
): Promise<boolean> => {
  try {
    const identity = await gatewayAuthenticator(env)(headers, request);
    if (!identity || !isAllowedUser(env, identity)) {
      return false;
    }
    return hasScope(identity, INTROSPECTION_SCOPE);
  } catch {
    // Fail closed: any verification or configuration error means not authorized.
    return false;
  }
};

export const buildBootstrapDiscovery = (env: Env) => {
  const oidc = oidcProvider(env);
  const base = issuer(env);
  return {
    oidc: {
      issuer: oidc.issuer,
      clientId: oidc.clientId,
      authorizationEndpoint: oidc.authorizationEndpoint,
      tokenEndpoint: oidc.tokenEndpoint,
      jwksEndpoint: oidc.jwksEndpoint,
    },
    auth_providers: [
      {
        id: "access",
        authorization_endpoint: oidc.authorizationEndpoint,
      },
      {
        id: "discord",
        authorization_endpoint: discordAuthorizeUrl(env),
      },
    ],
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
        applicationView(app, await listDelegations(env, app.name)),
      ),
    ),
    provider: providerConfigView(await getProviderConfig(env)),
  };
};

export const buildAuthorizationServerMetadata = async (env: Env) => {
  const discovered = await buildDiscovery(env);
  const scopes = new Set<string>(["openid", "email", "profile", "internal", "community"]);
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
    response_modes_supported: ["query"],
    grant_types_supported: [
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:token-exchange",
    ],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    revocation_endpoint_auth_methods_supported: ["none"],
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
