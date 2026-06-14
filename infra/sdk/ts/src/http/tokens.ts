export const AUTHORIZATION_HEADER = "authorization";
export const DPOP_HEADER = "dpop";
export const CLIENT_INSTANCE_HEADER = "x-client-instance";
export const CLIENT_TOKEN_HEADER = "x-client-token";
export const DEVICE_JKT_HEADER = "x-platy-device-jkt";
export const WEBHOOK_SIGNATURE_HEADER = "x-webhook-signature";

export type RequestContextArtifactKind =
  | "gateway-authorization-token"
  | "phantom-token"
  | "split-token";

export type IdentityContextProofKind =
  | "dpop-proof"
  | "client-instance-token"
  | "signed-webhook"
  | "workload-proof"
  | "mtls-certificate";

export interface ContextBindingPolicy {
  requestContext: RequestContextArtifactKind;
  identityContext: IdentityContextProofKind;
  requestBound: boolean;
}

export const DPOP_CONTEXT_BINDING_POLICY: ContextBindingPolicy = {
  requestContext: "gateway-authorization-token",
  identityContext: "dpop-proof",
  requestBound: true,
};

export const CLIENT_INSTANCE_CONTEXT_BINDING_POLICY: ContextBindingPolicy = {
  requestContext: "gateway-authorization-token",
  identityContext: "client-instance-token",
  requestBound: true,
};

export const SIGNED_WEBHOOK_CONTEXT_BINDING_POLICY: ContextBindingPolicy = {
  requestContext: "gateway-authorization-token",
  identityContext: "signed-webhook",
  requestBound: true,
};

export const WORKLOAD_CONTEXT_BINDING_POLICY: ContextBindingPolicy = {
  requestContext: "gateway-authorization-token",
  identityContext: "workload-proof",
  requestBound: true,
};
