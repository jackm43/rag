// The env slice the service-boundary library reads: the ServiceRegistry
// control plane and the per-principal Ed25519 signing material. Extracted from
// the old contracts god-Env; each app's Env intersects this slice.
export type ServiceKitEnv = {
  // ServiceRegistry Durable Object (hosted by ragbot-registry-worker). Typed
  // structurally like RESPONDER so contracts does not import worker code.
  // Both RPC payloads are capnp bytes (service.capnp: ServiceManifest in,
  // ManifestSnapshot out).
  SERVICE_REGISTRY?: {
    idFromName: (name: string) => DurableObjectId;
    get: (id: DurableObjectId) => {
      register: (manifest: Uint8Array) => Promise<void>;
      snapshot: () => Promise<Uint8Array>;
      createIntent: (record: {
        iss: string;
        sub: string;
        aud: string;
        jti: string;
        correlationId: string;
        subject: string;
        initiatingApplication: string;
        action: string;
        resource: string;
        method: string;
        allowedApplications: string[];
        ttlMs?: number;
      }) => Promise<{
        id: string;
        iss: string;
        sub: string;
        aud: string;
        iat: number;
        nbf: number;
        exp: number;
        jti: string;
        correlationId: string;
        subject: string;
        initiatingApplication: string;
        action: string;
        resource: string;
        method: string;
        allowedApplications: string[];
        expiresAt: number;
        version: number;
        revokedAt?: number;
      }>;
      createPlacement: (record: {
        iss: string;
        sub: string;
        aud: string;
        jti: string;
        correlationId: string;
        requestId: string;
        subject: string;
        source: string;
        target: string;
        action: string;
        resource: string;
        method: string;
        ttlMs?: number;
      }) => Promise<{
        id: string;
        iss: string;
        sub: string;
        aud: string;
        iat: number;
        nbf: number;
        exp: number;
        jti: string;
        correlationId: string;
        requestId: string;
        subject: string;
        source: string;
        target: string;
        action: string;
        resource: string;
        method: string;
        expiresAt: number;
        intentVersion: number;
      } | null>;
      consumePlacement: (input: {
        placementId: string;
        requestId: string;
        correlationId?: string;
        subject: string;
        source: string;
        target: string;
        action: string;
        resource: string;
        method: string;
      }) => Promise<boolean>;
      revokeIntent: (requestId: string) => Promise<{
        id: string;
        iss: string;
        sub: string;
        aud: string;
        iat: number;
        nbf: number;
        exp: number;
        jti: string;
        correlationId: string;
        subject: string;
        initiatingApplication: string;
        action: string;
        resource: string;
        method: string;
        allowedApplications: string[];
        expiresAt: number;
        version: number;
        revokedAt?: number;
      } | null>;
      bumpIntentVersion: (requestId: string) => Promise<{
        id: string;
        iss: string;
        sub: string;
        aud: string;
        iat: number;
        nbf: number;
        exp: number;
        jti: string;
        correlationId: string;
        subject: string;
        initiatingApplication: string;
        action: string;
        resource: string;
        method: string;
        allowedApplications: string[];
        expiresAt: number;
        version: number;
        revokedAt?: number;
      } | null>;
    };
  };
  // Production verifying keyring: JSON map of machine principal -> public JWK.
  // Overrides the committed default keyring in packages/service-kit/identity/keyring.ts.
  // Public keys are not secret, so this is a plain var, not a secret.
  SERVICE_PUBLIC_KEYS?: string;
  // Per-worker Ed25519 signing keys (private JWK JSON), provisioned as secrets.
  // Only the sending workers hold one: the gateway mints origin contexts, the
  // workflows re-mints on-behalf-of tokens for its downstream hops. Receivers read
  // public keys from the committed keyring, not these.
  GATEWAY_SIGNING_KEY?: string;
  WORKFLOWS_SIGNING_KEY?: string;
  RESPONDER_SIGNING_KEY?: string;
  CONNECTORS_SIGNING_KEY?: string;
  // The dev-proxy worker's Ed25519 signing key (private JWK JSON). Held only by
  // apps/connectors/workers/dev-proxy, which mints the on-behalf-of identity-context
  // token for each browser session's command hop into the gateway.
  DEV_PROXY_SIGNING_KEY?: string;
  // The webhook-ingress worker's Ed25519 signing key (private JWK JSON). Held
  // only by the webhooks edge worker, which mints the identity-context token
  // for its webhook_verify hop into the broker and its enqueue hop to the workflows worker.
  WEBHOOKS_SIGNING_KEY?: string;
  REGISTRY_SIGNING_KEY?: string;
  ATTEST_SIGNING_KEY?: string;
  METADATA_SIGNING_KEY?: string;
};
