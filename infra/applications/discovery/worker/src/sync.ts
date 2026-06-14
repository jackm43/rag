import {
  exchangeToken,
  logger,
  serviceBindingFetch,
  serviceCredentialFromEnv,
  TOKEN_TYPE_SERVICE_CREDENTIAL,
  type Identity,
} from "@platy/sdk";
import { targets } from "../../targets";
import type { DiscoveryStore, RegistrySnapshot, SyncStateView } from "./data";
import type { Env } from "./types";

export const DISCOVER_SCOPE = "idp/DiscoveryService.Discover";

// The cron path has no caller to chain: the worker acts as itself by
// exchanging its service credential for a gateway-issued subject token, which
// the connector then chains like any other caller identity.
export const selfIdentity = async (env: Env): Promise<Identity> => {
  const credential = serviceCredentialFromEnv(env);
  if (!credential) {
    throw new Error("service credential not configured");
  }
  const gatewayUrl = (env.AUTH_GATEWAY_URL ?? "").replace(/\/$/, "");
  const minted = await exchangeToken(
    gatewayUrl,
    {
      subjectToken: `${credential.clientId}:${credential.clientSecret}`,
      subjectTokenType: TOKEN_TYPE_SERVICE_CREDENTIAL,
      audience: "idp",
      scopes: [DISCOVER_SCOPE],
    },
    serviceBindingFetch(env.AUTH_GATEWAY, "AUTH_GATEWAY"),
  );
  if (!minted) {
    throw new Error("self token exchange refused");
  }
  return {
    kind: "service",
    subject: credential.clientId,
    email: null,
    scopes: minted.scopes,
    actorChain: [],
    subjectToken: minted.accessToken,
  };
};

type DiscoverApplicationLike = {
  name: string;
  audience: string;
  endpoint: string;
  description: string;
  provider: string;
  trustZone: string;
  impersonationAccessClientId?: string;
  providerOauthClientId?: string;
  providerOauthScopes?: string[];
  createdAt: number | bigint | string;
  updatedAt: number | bigint | string;
  trustBoundary?: unknown;
  access?: unknown;
  resources: Array<{ name: string; methods: Array<{ name: string; scope: string }> }>;
  delegations: Array<{ audience: string; scopes: string[] }>;
};

type DiscoverLike = {
  issuer: string;
  jwksUri: string;
  endpoints?: Partial<{
    tokenExchange: string;
    tokenRevoke: string;
    introspect: string;
    discovery: string;
    jwks: string;
  }>;
  applications: Array<
    DiscoverApplicationLike
  >;
};

export const snapshotFromDiscovery = (response: DiscoverLike): RegistrySnapshot => ({
  issuer: response.issuer,
  jwksUri: response.jwksUri,
  endpoints: response.endpoints
    ? {
      tokenExchange: response.endpoints.tokenExchange ?? "",
      tokenRevoke: response.endpoints.tokenRevoke ?? "",
      introspect: response.endpoints.introspect ?? "",
      discovery: response.endpoints.discovery ?? "",
      jwks: response.endpoints.jwks ?? "",
    }
    : null,
  applications: response.applications.map((application) => ({
    name: application.name,
    audience: application.audience,
    endpoint: application.endpoint,
    description: application.description,
    provider: application.provider,
    trustZone: application.trustZone,
    impersonationAccessClientId: application.impersonationAccessClientId ?? "",
    providerOauthClientId: application.providerOauthClientId ?? "",
    providerOauthScopes: application.providerOauthScopes ?? [],
    trustBoundary: application.trustBoundary ?? null,
    access: application.access ?? null,
    createdAt: Number(application.createdAt),
    updatedAt: Number(application.updatedAt),
    resources: application.resources.map((resource) => ({
      name: resource.name,
      methods: resource.methods.map((method) => ({ name: method.name, scope: method.scope })),
    })),
    delegations: application.delegations.map((delegation) => ({
      audience: delegation.audience,
      scopes: [...delegation.scopes],
    })),
  })),
});

export const syncRegistry = async (
  env: Env,
  store: DiscoveryStore,
  identity: Identity,
): Promise<SyncStateView> => {
  const response = await (await targets(env, identity).idp.discoveryService()).discover() as DiscoverLike;
  const state = await store.replace(snapshotFromDiscovery(response));
  logger.info("discovery_synced", {
    applications: state.applications,
    delegations: state.delegations,
    methods: state.methods,
  });
  return state;
};
