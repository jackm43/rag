// The env slice the pluggable secrets backends read. A connector's registry
// entry names one of these via {provider, ref}; the default provider is
// "wrangler-env", so these are only bound when an operator points a connector
// at a remote backend.
export type SecretsEnv = {
  //   SECRETS_STORE — a Cloudflare Secrets Store binding. Structurally typed as
  //     an async get(name) so contracts does not depend on the platform type;
  //     the cloudflare-secret-store provider reads a secret by name through it.
  SECRETS_STORE?: {
    get: (name: string) => Promise<string | null>;
  };
  //   VAULT_ADDR / VAULT_TOKEN / VAULT_NAMESPACE — HashiCorp Vault. The
  //     hashicorp-vault provider reads via the KV v2 HTTP API through a boundary
  //     client host-allowlisted to VAULT_ADDR's host, authenticating with
  //     VAULT_TOKEN (and VAULT_NAMESPACE for Vault Enterprise/HCP, when set).
  VAULT_ADDR?: string;
  VAULT_TOKEN?: string;
  VAULT_NAMESPACE?: string;
  //   OP_SERVICE_ACCOUNT_TOKEN — 1Password service account token. The
  //     onepassword provider resolves op://vault/item/field references through
  //     the official 1Password JavaScript SDK.
  OP_SERVICE_ACCOUNT_TOKEN?: string;
};
