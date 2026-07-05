import { errorMessage, logger } from "@rag/logger";

// Worker-to-worker calls are plain Cloudflare service-binding RPC now — no
// signed envelopes, no identity tokens. Trust is structural: only a worker whose
// wrangler declares the binding can reach the target `WorkerEntrypoint`, so the
// binding graph authenticates the caller. This package is the thin, shared
// convention layer: a uniform result shape so RPC methods report failure as data
// instead of throwing across the boundary, plus the binding type alias.

// A service binding to a worker exposing `T` (its `WorkerEntrypoint` subclass).
// The bound stub exposes T's public async methods; this alias documents intent
// at call sites and keeps `env` types honest.
export type ServiceBinding<T> = T;

// The uniform RPC result. Methods return this rather than throwing so a caller
// gets a typed failure (status + short reason) instead of an opaque exception
// crossing the isolate boundary.
export type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; reason: string };

export const rpcOk = <T>(value: T): RpcResult<T> => ({ ok: true, value });

export const rpcErr = (status: number, reason: string): RpcResult<never> => ({
  ok: false,
  status,
  reason,
});

// Wrap an RPC method body so an unexpected throw becomes a uniform 500 result
// (logged with the method name) rather than propagating across the binding.
export const rpcGuard = async <T>(
  method: string,
  body: () => Promise<RpcResult<T>>,
): Promise<RpcResult<T>> => {
  try {
    return await body();
  } catch (error) {
    logger.error("rpc_method_threw", { method, error: errorMessage(error) });
    return rpcErr(500, "internal_error");
  }
};
