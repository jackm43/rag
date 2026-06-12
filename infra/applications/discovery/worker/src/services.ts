import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";

import { DiscoveryService } from "../../server/discovery/v1/discovery_service_pb";
import {
  logger,
  protect,
  requireIdentity,
  stsAuthenticator,
  type AuthPolicy,
} from "../../../../sdk/ts/src";
import { d1Store } from "./data";
import { executeQuery } from "./graphql";
import { syncRegistry } from "./sync";
import type { Env } from "./types";

const parseVariables = (variablesJson: string): Record<string, unknown> | undefined => {
  if (!variablesJson) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(variablesJson);
  } catch {
    throw new ConnectError("variables_json is not valid JSON", Code.InvalidArgument);
  }
  if (parsed === null) {
    return undefined;
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConnectError("variables_json must be a JSON object", Code.InvalidArgument);
  }
  return parsed as Record<string, unknown>;
};

export const registerDiscoveryServices = (router: ConnectRouter, env: Env) => {
  const issuer = (env.AUTH_GATEWAY_URL ?? "").replace(/\/$/, "");
  const policy: AuthPolicy = {
    authenticate: stsAuthenticator({
      issuer,
      audience: "discovery",
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      gatewayFetch: env.AUTH_GATEWAY
        ? (input, init) => env.AUTH_GATEWAY!.fetch(input, init)
        : undefined,
    }),
  };
  const store = d1Store(env.DB);

  router.service(
    DiscoveryService,
    protect(
      DiscoveryService,
      {
        query: async (request) => {
          if (!request.query.trim()) {
            throw new ConnectError("query is required", Code.InvalidArgument);
          }
          const result = await executeQuery(store, {
            query: request.query,
            variables: parseVariables(request.variablesJson),
            operationName: request.operationName || undefined,
          });
          return {
            dataJson: result.dataJson,
            errors: result.errors,
          };
        },
        sync: async (_request, context) => {
          const identity = requireIdentity(context);
          logger.info("discovery_sync_requested", {
            actor: identity.email ?? identity.subject,
          });
          const state = await syncRegistry(env, store, identity);
          return {
            applications: state.applications,
            delegations: state.delegations,
            methods: state.methods,
            syncedAt: BigInt(state.syncedAt),
          };
        },
      },
      policy,
    ),
  );
};
