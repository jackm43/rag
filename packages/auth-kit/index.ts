// The auth library: verification primitives + per-client-kind authentication
// strategies, used by the auth worker (the API Gateway) and any worker that
// needs to verify a caller (e.g. webhooks' Discord Ed25519 check).
export * from "./guard";
export * from "./env";
export * from "./access";
export * from "./web";
export * from "./native";
export * from "./oauth2";
export * from "./discord";
export * from "./strategies";
export { timingSafeEqual } from "./timing-safe-equal";
