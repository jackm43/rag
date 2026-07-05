// Egress-boundary contracts: the plain RPC input/result the egress sidecar
// exchanges over its trusted service binding, plus its env slice and profile
// config types. No capnp envelope, no signing (that machinery is gone).

export type EgressResult = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: ArrayBuffer;
};

// The plain RPC input the egress sidecar receives. Only a worker whose wrangler
// declares the EGRESS binding can call, so the binding graph authenticates the
// caller; `caller` selects the (caller, profile) config + credential, gated by
// the profile's allowedCallers.
export type EgressFetchInput = {
  caller: string;
  profile: string;
  method: string;
  url: string;
  headers: Record<string, string>;
};

export type EgressCredentialRef = {
  header: string;
  env: string;
  prefix?: string;
};

export type EgressProfileConfig = {
  identity?: string;
  allowedCallers: string[];
  allowedHosts: string[];
  timeoutMs?: number;
  maxResponseBytes?: number;
  logPath?: boolean;
  credential?: EgressCredentialRef;
};

// The env slice the egress boundary reads: the generic bound egress proxy plus
// the per-caller profile-authority Durable Object.
export type EgressEnv = {
  EGRESS?: {
    fetchProfile: (input: EgressFetchInput, body?: ArrayBuffer) => Promise<EgressResult>;
  };
  EGRESS_CONTROL?: {
    idFromName: (name: string) => DurableObjectId;
    get: (id: DurableObjectId) => {
      getProfile: (profile: string) => Promise<EgressProfileConfig | null>;
      putProfile: (profile: string, config: EgressProfileConfig) => Promise<void>;
      snapshot: () => Promise<Record<string, EgressProfileConfig>>;
    };
  };
};

export const EGRESS_PROFILE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
