import type { JsonObject } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from "@connectrpc/connect";

import { DeployService } from "../../applications/deploy/server/deploy/v1/deploy_pb";
import { logger, protect, requireIdentity, stsAuthenticator, type AuthPolicy } from "../../sdk/ts/src";
import type { Env } from "./types";

const API_BASE_URL = "https://api.cloudflare.com/client/v4";
const DELEGATED_TOKEN_HEADER = "x-delegated-cloudflare-token";

const delegatedToken = (context: HandlerContext): string => {
  const token = context.requestHeader.get(DELEGATED_TOKEN_HEADER);
  if (!token) {
    throw new ConnectError(
      `missing ${DELEGATED_TOKEN_HEADER} header with a delegated Cloudflare token`,
      Code.Unauthenticated,
    );
  }
  return token;
};

type ApiEnvelope<T> = {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: T;
};

const apiResult = async <T>(response: Response): Promise<T> => {
  const body = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !body.success || body.result === undefined) {
    const detail = (body.errors ?? []).map((error) => `${error.code} ${error.message}`).join("; ");
    throw new ConnectError(
      `cloudflare api error (${response.status}): ${detail || "unknown"}`,
      Code.FailedPrecondition,
    );
  }
  return body.result;
};

export const registerDeployServices = (router: ConnectRouter, env: Env) => {
  const policy: AuthPolicy = {
    authenticate: stsAuthenticator({
      issuer: (env.AUTH_GATEWAY_URL ?? "").replace(/\/$/, ""),
      audience: "deploy",
    }),
  };

  router.service(
    DeployService,
    protect(
      DeployService,
      {
        deployWorker: async (request, context) => {
          const identity = requireIdentity(context);
          const token = delegatedToken(context);
          if (!request.scriptName || !/^[a-z0-9-]+$/.test(request.scriptName)) {
            throw new ConnectError("script_name must be lowercase alphanumeric", Code.InvalidArgument);
          }
          if (!request.mainModule || request.modules.length === 0) {
            throw new ConnectError("main_module and at least one module are required", Code.InvalidArgument);
          }

          const metadata: JsonObject = {
            main_module: request.mainModule,
            compatibility_date: request.compatibilityDate || "2026-04-23",
            compatibility_flags: request.compatibilityFlags,
          };
          if (request.metadata) {
            Object.assign(metadata, request.metadata);
          }

          const form = new FormData();
          form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
          for (const module of request.modules) {
            form.set(
              module.name,
              new File([module.content as BlobPart], module.name, {
                type: module.contentType || "application/javascript+module",
              }),
            );
          }

          logger.info("deploy_worker_requested", {
            script: request.scriptName,
            actor: identity.email ?? identity.subject,
          });
          const response = await fetch(
            `${API_BASE_URL}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${request.scriptName}`,
            {
              method: "PUT",
              headers: { authorization: `Bearer ${token}` },
              body: form,
            },
          );
          const result = await apiResult<{ id?: string; etag?: string; modified_on?: string }>(response);
          return {
            scriptName: request.scriptName,
            etag: result.etag ?? "",
            modifiedOn: result.modified_on ?? "",
          };
        },
        listWorkers: async (_request, context) => {
          requireIdentity(context);
          const token = delegatedToken(context);
          const response = await fetch(
            `${API_BASE_URL}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts`,
            { headers: { authorization: `Bearer ${token}` } },
          );
          const result = await apiResult<Array<{ id?: string; modified_on?: string }>>(response);
          return {
            workers: result.map((script) => ({
              name: script.id ?? "",
              modifiedOn: script.modified_on ?? "",
            })),
          };
        },
      },
      policy,
    ),
  );
};
