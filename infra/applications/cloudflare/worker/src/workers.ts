import type { JsonObject } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";

import type { PlatformClient } from "@platy/sdk";
import type {
  DeployWorkerRequest,
  ListWorkersRequest,
} from "../../server/cloudflare/v1/worker_service_pb";
import { apiRequest } from "./api";

export const deployWorker = async (
  client: PlatformClient,
  accountId: string,
  request: DeployWorkerRequest,
) => {
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

  const response = await client.fetch(`/accounts/${accountId}/workers/scripts/${request.scriptName}`, {
    method: "PUT",
    body: form,
  });
  const body = (await response.json()) as {
    success: boolean;
    errors?: Array<{ code: number; message: string }>;
    result?: { id?: string; etag?: string; modified_on?: string };
  };
  if (!response.ok || !body.success || !body.result) {
    const detail = (body.errors ?? []).map((error) => `${error.code} ${error.message}`).join("; ");
    throw new ConnectError(
      `cloudflare api error (${response.status}): ${detail || "unknown"}`,
      Code.FailedPrecondition,
    );
  }
  return {
    scriptName: request.scriptName,
    etag: body.result.etag ?? "",
    modifiedOn: body.result.modified_on ?? "",
  };
};

export const listWorkers = async (
  client: PlatformClient,
  accountId: string,
  _request: ListWorkersRequest,
) => {
  const { result } = await apiRequest<Array<{ id?: string; modified_on?: string }>>(
    client,
    `/accounts/${accountId}/workers/scripts`,
  );
  return {
    workers: result.map((script) => ({
      name: script.id ?? "",
      modifiedOn: script.modified_on ?? "",
    })),
  };
};
