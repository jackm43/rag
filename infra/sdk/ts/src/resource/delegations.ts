import type { Identity } from "../identity";
import type { ServiceCredential } from "../oauth2/credential";
import { createDpopProof, DPOP_HEADER, generateDpopKey, type DpopKey } from "../oauth2/dpop";
import { exchangeToken } from "../oauth2/exchange";
import { TOKEN_TYPE_SERVICE_CREDENTIAL } from "../oauth2/sts";
import { logger } from "../logger";
import { scopeMatches } from "./scope";

// Receiving services re-validate the actor chain on inbound tokens against
// the gateway's registered delegations (published in discovery): the token
// signature proves the gateway minted it, the chain check proves every hop is
// still an expected, currently-delegated path. This is the receiver half of
// the transitive-identity standard; the gateway enforces the same rule at
// issuance against its registry.

// application name -> audience -> granted scopes for that delegation
export type DelegationGraph = Map<string, Map<string, string[]>>;

// Service client ids are minted by the gateway as svc_{application}_{random}
// where application names never contain underscores.
export const applicationFromClientId = (clientId: string): string | null => {
  if (!clientId.startsWith("svc_")) {
    return null;
  }
  const end = clientId.lastIndexOf("_");
  if (end <= "svc_".length) {
    return null;
  }
  return clientId.slice("svc_".length, end);
};

type DiscoveryDocument = {
  applications?: {
    name?: string;
    delegations?: { audience?: string; scopes?: string[] }[];
  }[];
};

export const delegationGraphFromDiscovery = (document: DiscoveryDocument): DelegationGraph => {
  const graph: DelegationGraph = new Map();
  for (const application of document.applications ?? []) {
    if (!application.name) {
      continue;
    }
    const delegations = new Map<string, string[]>();
    for (const delegation of application.delegations ?? []) {
      if (!delegation.audience) {
        continue;
      }
      delegations.set(delegation.audience, delegation.scopes ?? []);
    }
    graph.set(application.name, delegations);
  }
  return graph;
};

const CACHE_TTL_MS = 300_000;
const DISCOVER_SCOPE = "idp/DiscoveryService.Discover";

let discoverDpopKey: Promise<DpopKey> | null = null;

const discoverDpopKeyFor = (): Promise<DpopKey> => {
  discoverDpopKey ??= generateDpopKey();
  return discoverDpopKey;
};

type CacheEntry = {
  graph: DelegationGraph;
  fetchedAt: number;
};

const cache = new Map<string, CacheEntry>();

export type DelegationGraphSource = {
  issuer: string;
  gatewayFetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  credential?: ServiceCredential;
};

const discoverDocument = async (
  issuer: string,
  gatewayFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  credential?: ServiceCredential,
): Promise<DiscoveryDocument> => {
  const base = issuer.replace(/\/$/, "");
  let accessToken = "";
  if (credential) {
    const minted = await exchangeToken(
      base,
      {
        subjectToken: `${credential.clientId}:${credential.clientSecret}`,
        subjectTokenType: TOKEN_TYPE_SERVICE_CREDENTIAL,
        audience: "idp",
        scopes: [DISCOVER_SCOPE],
      },
      gatewayFetch,
    );
    if (!minted?.accessToken) {
      throw new Error("discover token exchange refused");
    }
    accessToken = minted.accessToken;
  } else {
    throw new Error("delegation graph requires a service credential");
  }
  const url = `${base}/platform/gateway/v1/discovery`;
  const dpop = await discoverDpopKeyFor();
  const response = await gatewayFetch(url, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      [DPOP_HEADER]: await createDpopProof(dpop, { method: "GET", url }, accessToken),
    },
  });
  if (!response.ok) {
    throw new Error(`discover returned ${response.status}`);
  }
  const envelope = (await response.json()) as { data?: DiscoveryDocument };
  return envelope.data ?? {};
};

// Fetch the delegation graph from the protected gateway Discover RPC, cached
// per issuer. On fetch failure a stale graph is preferred over rejecting all
// chained requests; with no graph at all the caller must fail closed.
export const delegationGraph = async (
  source: string | DelegationGraphSource,
  legacyFetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): Promise<DelegationGraph | null> => {
  const config: DelegationGraphSource =
    typeof source === "string"
      ? { issuer: source, gatewayFetch: legacyFetch }
      : source;
  const issuer = config.issuer.replace(/\/$/, "");
  const gatewayFetch = config.gatewayFetch ?? fetch;
  const entry = cache.get(issuer);
  const now = Date.now();
  if (entry && now - entry.fetchedAt < CACHE_TTL_MS) {
    return entry.graph;
  }
  try {
    const document = await discoverDocument(issuer, gatewayFetch, config.credential);
    const graph = delegationGraphFromDiscovery(document);
    cache.set(issuer, { graph, fetchedAt: now });
    return graph;
  } catch (error) {
    logger.warn("delegation_graph_fetch_failed", {
      issuer,
      error: error instanceof Error ? error.message : String(error),
    });
    return entry?.graph ?? null;
  }
};

const delegationScopes = (
  graph: DelegationGraph,
  application: string,
  audience: string,
): string[] | null => {
  const scopes = graph.get(application)?.get(audience);
  if (scopes === undefined) {
    return null;
  }
  return scopes.length > 0 ? scopes : [`${audience}/*`];
};

// Validate a verified identity's actor chain against the delegation graph.
// chain[0] minted this token for `audience` and its delegation must also
// cover the token's scopes; each deeper hop minted the token its predecessor
// consumed, whose audience was the predecessor's application (or a gateway
// session token, aud "idp"). Returns a refusal reason, or null when valid.
export const actorChainRefusal = (
  identity: Identity,
  audience: string,
  graph: DelegationGraph,
): string | null => {
  const chain = identity.actorChain;
  if (chain.length === 0) {
    return null;
  }
  let previousApplication: string | null = null;
  for (const [index, clientId] of chain.entries()) {
    const application = applicationFromClientId(clientId);
    if (!application || !graph.has(application)) {
      return `unknown actor ${clientId} in chain`;
    }
    if (index === 0) {
      const granted = delegationScopes(graph, application, audience);
      if (!granted) {
        return `application ${application} has no delegation to audience ${audience}`;
      }
      const uncovered = identity.scopes.find(
        (scope) => !granted.some((grant) => scopeMatches(grant, scope)),
      );
      if (uncovered) {
        return `delegation ${application} -> ${audience} does not grant ${uncovered}`;
      }
    } else if (
      !previousApplication ||
      (!graph.get(application)?.has(previousApplication) && !graph.get(application)?.has("idp"))
    ) {
      return `application ${application} has no delegation covering its position in the actor chain`;
    }
    previousApplication = application;
  }
  return null;
};
