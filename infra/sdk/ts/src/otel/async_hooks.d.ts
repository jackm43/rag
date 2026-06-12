// The root tsconfig pins global types to workers-types, so @types/node's
// ambient module declarations are not loaded. Declare the one node builtin
// the SDK uses; the workers runtime provides it under nodejs_compat.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  }
}
