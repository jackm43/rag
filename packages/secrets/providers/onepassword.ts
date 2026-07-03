import { createBoundaryClient, type BoundaryFetch } from "../../boundaries/outbound/boundary-client";
import type { Env } from "../../contracts/types";
import { errorMessage, logger } from "../../logger";
import type { SecretsProvider } from "../types";

// onepassword: resolves an "op://<vault>/<item>/<field>" reference via the
// 1Password Connect REST API through a boundary client host-allowlisted to
// OP_CONNECT_HOST, authenticating with OP_CONNECT_TOKEN. Everything fails closed
// (unconfigured backend, malformed reference, non-2xx, missing item/field ->
// null).
//
// Why Connect and not the official SDK: the @1password/sdk package is Node-only
// — its @1password/sdk-core loads a ~10MB WASM synchronously via
// `require('fs').readFileSync(require('path').join(__dirname,'core_bg.wasm'))`
// at module load, which cannot work on workerd (no filesystem; Workers require
// WASM as a bundled import, not runtime-read bytes). The Connect HTTP API is the
// supported way to read op:// references from a non-Node runtime. See
// CONNECTORS.md for the full spike writeup.
//
// Connect has no single "resolve op:// reference" endpoint, so this walks its
// REST surface: vault name -> vault id, item title -> item id, then the item's
// fields, matched by field label or id. op:// references use names/titles.

const OP_TIMEOUT_MS = 10_000;

type ParsedRef = { vault: string; item: string; field: string };

const parseRef = (ref: string): ParsedRef | null => {
  if (!ref.startsWith("op://")) {
    return null;
  }
  const [vault, item, ...fieldParts] = ref.slice("op://".length).split("/");
  const field = fieldParts.join("/");
  if (!vault || !item || !field) {
    return null;
  }
  return { vault, item, field };
};

export const onepasswordProvider = (env: Env): SecretsProvider => {
  const host = env.OP_CONNECT_HOST;
  const token = env.OP_CONNECT_TOKEN;

  const boundary = (): { fetch: BoundaryFetch; base: string } | null => {
    if (!host || !token) {
      return null;
    }
    let hostname: string;
    try {
      hostname = new URL(host).hostname;
    } catch {
      return null;
    }
    return {
      fetch: createBoundaryClient({
        identity: "secrets-onepassword",
        trustZone: "egress-onepassword",
        allowedHosts: [hostname],
        defaultTimeoutMs: OP_TIMEOUT_MS,
        // Paths carry vault/item ids — keep failure logs host-only.
        logPath: false,
      }),
      base: host.replace(/\/$/, ""),
    };
  };

  const jsonGet = async (fetch: BoundaryFetch, url: string): Promise<unknown> => {
    const response = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token as string}`, accept: "application/json" },
    });
    return response.ok ? response.json() : null;
  };

  // Connect's filter query is SCIM-like: `name eq "…"` / `title eq "…"`.
  const filtered = (base: string, path: string, field: string, value: string): string =>
    `${base}${path}?filter=${encodeURIComponent(`${field} eq "${value}"`)}`;

  const firstId = (list: unknown): string | null =>
    Array.isArray(list) && typeof (list[0] as { id?: unknown })?.id === "string"
      ? (list[0] as { id: string }).id
      : null;

  return {
    get: async (ref) => {
      const client = boundary();
      const parsed = parseRef(ref);
      if (!client || !parsed) {
        return null;
      }
      try {
        const vaultId = firstId(
          await jsonGet(client.fetch, filtered(client.base, "/v1/vaults", "name", parsed.vault)),
        );
        if (!vaultId) {
          return null;
        }
        const itemId = firstId(
          await jsonGet(
            client.fetch,
            filtered(client.base, `/v1/vaults/${vaultId}/items`, "title", parsed.item),
          ),
        );
        if (!itemId) {
          return null;
        }
        const item = (await jsonGet(client.fetch, `${client.base}/v1/vaults/${vaultId}/items/${itemId}`)) as {
          fields?: Array<{ id?: string; label?: string; value?: unknown }>;
        } | null;
        const match = item?.fields?.find((f) => f.label === parsed.field || f.id === parsed.field);
        return typeof match?.value === "string" && match.value.length > 0 ? match.value : null;
      } catch (error) {
        logger.warn("onepassword_read_failed", { error: errorMessage(error) });
        return null;
      }
    },
  };
};
