import type { DiscoverResponse } from "../../../idp/server/idp/v1/gateway_discovery_service_pb";
import {
  exchangeToken,
  logger,
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
    env.AUTH_GATEWAY
      ? (input, init) => env.AUTH_GATEWAY!.fetch(input, init)
      : undefined,
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

type DiscoverLike = Pick<DiscoverResponse, "issuer" | "jwksUri"> & {
  endpoints?: Partial<NonNullable<DiscoverResponse["endpoints"]>>;
  applications: Array<
    Pick<
      DiscoverResponse["applications"][number],
      | "name"
      | "audience"
      | "endpoint"
      | "description"
      | "provider"
      | "trustZone"
      | "impersonationAccessClientId"
      | "providerOauthClientId"
      | "providerOauthScopes"
      | "createdAt"
      | "updatedAt"
    > & {
      trustBoundary?: unknown;
      access?: unknown;
      resources: Array<{ name: string; methods: Array<{ name: string; scope: string }> }>;
      delegations: Array<{ audience: string; scopes: string[] }>;
    }
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
    impersonationAccessClientId: application.impersonationAccessClientId,
    providerOauthClientId: application.providerOauthClientId,
    providerOauthScopes: application.providerOauthScopes,
    trustBoundary: application.trustBoundary,
    access: application.access,
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
  const response = await targets(env, identity).idp.discoveryService().discover({});
  const state = await store.replace(snapshotFromDiscovery(response));
  logger.info("discovery_synced", {
    applications: state.applications,
    delegations: state.delegations,
    methods: state.methods,
  });
  return state;
};
