import type { ConnectRouter } from "@connectrpc/connect";

import { DeployService } from "../../server/deploy/v1/deploy_service_pb";
import { logger, platformAuthenticator, protect, requireIdentity, type AuthPolicy } from "@platy/sdk";
import { targets } from "../../targets";
import type { Env } from "./types";

export const registerDeployServices = (router: ConnectRouter, env: Env) => {
  const policy: AuthPolicy = { authenticate: platformAuthenticator(env, "deploy") };

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
          const result = await targets(env, identity).cloudflare.workerService().deployWorker({
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
          const result = await targets(env, identity).cloudflare.workerService().listWorkers({});
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
