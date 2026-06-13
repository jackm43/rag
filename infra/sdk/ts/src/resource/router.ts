import { createConnectRouter, type ConnectRouter } from "@connectrpc/connect";
import { createFetchHandler } from "@connectrpc/connect/protocol";

export type RpcHandler = (request: Request) => Promise<Response | null>;

export const createRpcHandler = (init: (router: ConnectRouter) => void): RpcHandler => {
  const router = createConnectRouter();
  init(router);
  const handlers = new Map(
    router.handlers.map((handler) => [handler.requestPath, createFetchHandler(handler)]),
  );
  return async (request) => {
    const url = new URL(request.url);
    const handler = handlers.get(url.pathname);
    if (!handler) {
      return null;
    }
    return handler(request);
  };
};
