import { Code, ConnectError } from "@connectrpc/connect";

import { chatServiceClient as aigatewayChatServiceClient } from "../../../aigateway/service";
import {
  exchangeToken,
  serviceConnection,
  serviceCredentialFromEnv,
  TOKEN_TYPE_SERVICE_CREDENTIAL,
  type Identity,
} from "../../../../sdk/ts/src";
import type { Env } from "./types";

export const AIGATEWAY_CHAT_SCOPES = [
  "aigateway/ChatService.Complete",
  "aigateway/ChatService.StreamComplete",
] as const;

export const aigatewayConnection = (env: Env) =>
  serviceConnection(env, {
    endpoint: env.AIGATEWAY_ENDPOINT,
    binding: env.AIGATEWAY,
    scopes: [...AIGATEWAY_CHAT_SCOPES],
  });

export const chatServiceClient = (env: Env, identity: Identity) => {
  const connection = aigatewayConnection(env);
  if (!connection) {
    throw new ConnectError("aigateway connector is not configured", Code.FailedPrecondition);
  }
  return aigatewayChatServiceClient(connection, identity);
};

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
      audience: "ragbot",
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
