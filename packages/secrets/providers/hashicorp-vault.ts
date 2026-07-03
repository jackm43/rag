import { createBoundaryClient, type BoundaryFetch } from "../../boundaries/outbound/boundary-client";
import type { Env } from "../../contracts/types";
import { errorMessage, logger } from "../../logger";
import type { SecretsProvider } from "../types";

// hashicorp-vault: reads (and, for the future UI, writes) a secret via Vault's
// KV v2 HTTP API through a boundary client host-allowlisted to VAULT_ADDR's
// host, authenticating with VAULT_TOKEN. Everything fails closed: an
// unconfigured backend, a malformed reference, an insecure/unreachable address,
// a non-2xx, or a missing field all resolve to null.
//
// KV v2 reference shape: "<mount>/<path>#<field>". KV v2 inserts a "data"
// segment on the wire — GET /v1/<mount>/data/<path> — and the value lives at
// .data.data.<field> in the response. Example ref:
//   "secret/ragbot#GITHUB_APP_PRIVATE_KEY"  ->  GET /v1/secret/data/ragbot

const VAULT_TIMEOUT_MS = 10_000;

type ParsedRef = { mount: string; path: string; field: string };

const parseRef = (ref: string): ParsedRef | null => {
  const [locator, field] = ref.split("#");
  if (!field) {
    return null;
  }
  const segments = locator.split("/").filter(Boolean);
  if (segments.length < 2) {
    return null;
  }
  const [mount, ...rest] = segments;
  return { mount, path: rest.join("/"), field };
};

export const hashicorpVaultProvider = (env: Env): SecretsProvider => {
  const address = env.VAULT_ADDR;
  const token = env.VAULT_TOKEN;

  // Build the host-allowlisted boundary client for VAULT_ADDR's host, or null
  // when the backend is not configured / the address is unparseable.
  const boundary = (): { fetch: BoundaryFetch; base: string } | null => {
    if (!address || !token) {
      return null;
    }
    let host: string;
    try {
      host = new URL(address).hostname;
    } catch {
      return null;
    }
    return {
      fetch: createBoundaryClient({
        identity: "secrets-vault",
        trustZone: "egress-vault",
        allowedHosts: [host],
        defaultTimeoutMs: VAULT_TIMEOUT_MS,
        // KV paths are secret locators — keep failure logs host-only.
        logPath: false,
      }),
      base: address.replace(/\/$/, ""),
    };
  };

  const headers = (): Record<string, string> => ({
    "x-vault-token": token as string,
    ...(env.VAULT_NAMESPACE ? { "x-vault-namespace": env.VAULT_NAMESPACE } : {}),
    accept: "application/json",
  });

  return {
    get: async (ref) => {
      const client = boundary();
      const parsed = parseRef(ref);
      if (!client || !parsed) {
        return null;
      }
      try {
        const response = await client.fetch(
          `${client.base}/v1/${parsed.mount}/data/${parsed.path}`,
          { method: "GET", headers: headers() },
        );
        if (!response.ok) {
          return null;
        }
        const body = (await response.json()) as { data?: { data?: Record<string, unknown> } };
        const value = body.data?.data?.[parsed.field];
        return typeof value === "string" && value.length > 0 ? value : null;
      } catch (error) {
        logger.warn("vault_read_failed", { error: errorMessage(error) });
        return null;
      }
    },
    set: async (ref, value) => {
      const client = boundary();
      const parsed = parseRef(ref);
      if (!client || !parsed) {
        throw new Error("vault_set_misconfigured");
      }
      const response = await client.fetch(
        `${client.base}/v1/${parsed.mount}/data/${parsed.path}`,
        {
          method: "POST",
          headers: { ...headers(), "content-type": "application/json" },
          body: JSON.stringify({ data: { [parsed.field]: value } }),
        },
      );
      if (!response.ok) {
        throw new Error(`vault_set_status:${response.status}`);
      }
    },
    configured: () => Boolean(address && token),
  };
};
