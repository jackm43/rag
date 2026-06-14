import {
  connectorToken,
  createClient,
  generateDpopKey,
  serviceConnection,
  traceHeaders,
  type DpopKey,
  type Identity,
  type ServiceConnectionEnv,
} from "@platy/sdk";
import { ragbot } from "../../ragbot/service";

type Fetcher = { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };

export type TargetsEnv = ServiceConnectionEnv & {
  RAGBOT?: Fetcher;
  RAGBOT_ENDPOINT?: string;
};

const idpConnection = (env: TargetsEnv) =>
  serviceConnection(env, {
    endpoint: env.AUTH_GATEWAY_URL,
    binding: env.AUTH_GATEWAY,
    bindingName: "AUTH_GATEWAY",
    scopes: ["idp/DiscoveryService.Discover"],
  });

const ragbotConnection = (env: TargetsEnv) =>
  serviceConnection(env, {
    endpoint: env.RAGBOT_ENDPOINT,
    binding: env.RAGBOT,
    bindingName: "RAGBOT",
    scopes: ["ragbot/LeaderboardService.ListTotals"],
  });

let dpopKeyPromise: Promise<DpopKey> | null = null;

const dpopKey = (): Promise<DpopKey> => {
  dpopKeyPromise ??= generateDpopKey();
  return dpopKeyPromise;
};

export const targets = (env: TargetsEnv, identity: Identity) => ({
  idp: {
    discoveryService: async () => {
      const connection = await idpConnection(env);
      if (!connection) {
        throw new Error("idp service connection unavailable (missing endpoint or credential)");
      }
      const client = createClient({
        endpoint: connection.endpoint,
        fetch: connection.fetch,
        token: () => connectorToken({ ...connection, application: "idp" }, identity),
        dpop: await dpopKey(),
        decorate: (headers) => {
          for (const [key, value] of Object.entries(traceHeaders())) {
            headers.set(key, value);
          }
        },
      });
      return {
        discover: async () => {
          const response = await client.fetch("/platform/gateway/v1/discovery");
          const body = await response.json() as { data?: unknown; errors?: Array<{ detail?: string; title?: string }> };
          if (!response.ok) {
            throw new Error(body.errors?.[0]?.detail ?? body.errors?.[0]?.title ?? `gateway discovery failed (${response.status})`);
          }
          return body.data;
        },
      };
    },
  },
  ragbot: {
    leaderboardService: async () => {
      const connection = await ragbotConnection(env);
      if (!connection) {
        throw new Error("ragbot service connection unavailable (missing endpoint or credential)");
      }
      return ragbot.leaderboardServiceClient(connection, identity);
    },
  },
});
