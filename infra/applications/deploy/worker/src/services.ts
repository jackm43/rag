import type { ConnectRouter } from "@connectrpc/connect";

import { DeployService } from "../../server/deploy/v1/deploy_service_pb";
import { logger, protect, requireIdentity, stsAuthenticator, type AuthPolicy } from "../../../../sdk/ts/src";
import { workerServiceClient } from "./connector";
import type { Env } from "./types";

export const registerDeployServices = (router: ConnectRouter, env: Env) => {
  const issuer = (env.AUTH_GATEWAY_URL ?? "").replace(/\/$/, "");
  const policy: AuthPolicy = {
    authenticate: stsAuthenticator({
      issuer,
      audience: "deploy",
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      gatewayFetch: env.AUTH_GATEWAY
        ? (input, init) => env.AUTH_GATEWAY!.fetch(input, init)
        : undefined,
    }),
  };

  router.service(
    DeployService,
    protect(
      DeployService,
      {
        deployWorker: async (request, context) => {
          const identity = requireIdentity(context);
          logger.info("deploy_worker_requested", {
            script: request.scriptName,
            actor: identity.email ?? identity.subject,
          });
          const result = await workerServiceClient(env, identity).deployWorker({
            scriptName: request.scriptName,
            mainModule: request.mainModule,
            modules: request.modules.map((module) => ({
              name: module.name,
              contentType: module.contentType,
              content: module.content,
            })),
            compatibilityDate: request.compatibilityDate,
            compatibilityFlags: request.compatibilityFlags,
            metadata: request.metadata,
          });
          return {
            scriptName: result.scriptName,
            etag: result.etag,
            modifiedOn: result.modifiedOn,
          };
        },
        listWorkers: async (_request, context) => {
          const identity = requireIdentity(context);
          const result = await workerServiceClient(env, identity).listWorkers({});
          return {
            workers: result.workers.map((worker) => ({
              name: worker.name,
              modifiedOn: worker.modifiedOn,
            })),
          };
        },
      },
      policy,
    ),
  );
};
