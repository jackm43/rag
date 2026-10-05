/// <reference types="vite/client" />
// workerd provides node:async_hooks with the nodejs_als flag; Node's type package is not installed.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  }
}
