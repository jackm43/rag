import { errorMessage, logger } from "../logger";
import type { SecretRef } from "../secrets";
import type { GrantEntry } from "./types";

// Persistence for the broker. Two stores sit on one strongly-consistent,
// persistent key/value substrate (the CONNECTOR_STORE Durable Object in
// production): the GRANT store (opaque handle -> actor context + credential
// reference) and the 3LO OAUTH TOKEN store (per connector+subject user tokens).
//
// Both are pluggable behind KeyValueStore so tests use an in-memory backing and
// the worker uses the Durable Object. Neither store holds a static provider
// secret — grants keep only a reference (re-resolved on use), and OAuth tokens
// are optionally envelope-encrypted at the application layer on top of the DO's
// at-rest encryption.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const b64urlFromBytes = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const bytesFromB64url = (value: string): Uint8Array => {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

// A high-entropy, url-safe opaque handle (the phantom token): a `cg_` prefix
// plus 256 bits of randomness. It is a bearer reference — its only power is to
// look up a grant that is additionally bound to the caller principal — so it
// carries no structure an attacker could forge or predict.
export const generateHandle = (): string =>
  `cg_${b64urlFromBytes(crypto.getRandomValues(new Uint8Array(32)))}`;

// The generic substrate. `write` accepts an optional TTL so the backing store
// can expire entries itself; the stores also re-check expiry on read (defence in
// depth — never trust the substrate to have expired an entry).
export type KeyValueStore = {
  read: (key: string) => Promise<string | null>;
  write: (key: string, value: string, ttlMs?: number) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

// In-memory backing for tests and cold fallbacks. Not shared across isolates, so
// it is never used in production (the worker binds the Durable Object).
export const createInMemoryKeyValueStore = (now: () => number = Date.now): KeyValueStore => {
  const entries = new Map<string, { value: string; expiresAt?: number }>();
  return {
    read: async (key) => {
      const entry = entries.get(key);
      if (!entry) {
        return null;
      }
      if (entry.expiresAt !== undefined && entry.expiresAt <= now()) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    write: async (key, value, ttlMs) => {
      entries.set(key, { value, ...(ttlMs !== undefined ? { expiresAt: now() + ttlMs } : {}) });
    },
    remove: async (key) => {
      entries.delete(key);
    },
  };
};

// Adapter over the CONNECTOR_STORE Durable Object stub (structurally typed on
// Env). One instance addresses one DO; the store keys namespace grants and OAuth
// tokens apart.
type ConnectorStoreBinding = NonNullable<import("../contracts/types").Env["CONNECTOR_STORE"]>;

export const durableObjectKeyValueStore = (binding: ConnectorStoreBinding): KeyValueStore => {
  const stub = binding.get(binding.idFromName("connector-store"));
  return {
    read: (key) => stub.read(key),
    write: (key, value, ttlMs) => stub.write(key, value, ttlMs),
    remove: (key) => stub.remove(key),
  };
};

const GRANT_PREFIX = "grant:";
const OAUTH_PREFIX = "oauth:";
const CONFIG_PREFIX = "config:";

export type GrantStore = {
  put: (entry: GrantEntry) => Promise<void>;
  // Returns the entry only when present AND not expired; otherwise null.
  get: (handle: string) => Promise<GrantEntry | null>;
  remove: (handle: string) => Promise<void>;
};

export const createGrantStore = (kv: KeyValueStore, now: () => number = Date.now): GrantStore => ({
  put: async (entry) => {
    await kv.write(`${GRANT_PREFIX}${entry.handle}`, JSON.stringify(entry), entry.expiresAt - now());
  },
  get: async (handle) => {
    const raw = await kv.read(`${GRANT_PREFIX}${handle}`);
    if (!raw) {
      return null;
    }
    try {
      const entry = JSON.parse(raw) as GrantEntry;
      if (entry.expiresAt <= now()) {
        await kv.remove(`${GRANT_PREFIX}${handle}`);
        return null;
      }
      return entry;
    } catch (error) {
      logger.warn("connector_grant_decode_failed", { error: errorMessage(error) });
      return null;
    }
  },
  remove: async (handle) => {
    await kv.remove(`${GRANT_PREFIX}${handle}`);
  },
});

// The connector CONFIG store: an admin-set override of a connector's secret
// reference, keyed by connectorId. The registry (registry.ts) is immutable code,
// so setConnectorSecret cannot mutate the registry entry — instead it persists a
// {provider, ref} override here, and the broker overlays it on the registry
// entry when resolving a credential (so the change survives and takes effect).
// It holds a REFERENCE only, never a secret value — the value (when the backend
// is runtime-writable) lives in the secrets backend, exactly like every other
// connector secret. An absent override means the registry default stands.
export type ConnectorConfigStore = {
  getSecretRef: (connectorId: string) => Promise<SecretRef | null>;
  setSecretRef: (connectorId: string, ref: SecretRef) => Promise<void>;
};

const isSecretRef = (value: unknown): value is SecretRef =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as SecretRef).provider === "string" &&
  typeof (value as SecretRef).ref === "string";

export const createConnectorConfigStore = (kv: KeyValueStore): ConnectorConfigStore => ({
  getSecretRef: async (connectorId) => {
    const raw = await kv.read(`${CONFIG_PREFIX}${connectorId}`);
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      return isSecretRef(parsed) ? { provider: parsed.provider, ref: parsed.ref } : null;
    } catch (error) {
      logger.warn("connector_config_decode_failed", { connectorId, error: errorMessage(error) });
      return null;
    }
  },
  setSecretRef: async (connectorId, ref) => {
    await kv.write(`${CONFIG_PREFIX}${connectorId}`, JSON.stringify({ provider: ref.provider, ref: ref.ref }));
  },
});

// A stored 3LO user token set, keyed by (connectorId, subject).
export type StoredOAuthToken = {
  accessToken: string;
  refreshToken?: string;
  // Epoch seconds.
  expiresAt?: number;
  scopes: string[];
};

export type OAuthTokenStore = {
  get: (connectorId: string, subject: string) => Promise<StoredOAuthToken | null>;
  put: (connectorId: string, subject: string, token: StoredOAuthToken) => Promise<void>;
  remove: (connectorId: string, subject: string) => Promise<void>;
};

const AES_GCM = { name: "AES-GCM" } as const;

// Optional envelope encryption for stored OAuth tokens. The key is a base64url
// 32-byte secret; absent, values are stored as plaintext JSON on top of the DO's
// own at-rest encryption. A ciphertext is `iv.ciphertext` (both base64url).
const importEncKey = (raw: string): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", bytesFromB64url(raw) as unknown as BufferSource, AES_GCM, false, [
    "encrypt",
    "decrypt",
  ]);

const seal = async (key: CryptoKey | null, plaintext: string): Promise<string> => {
  if (!key) {
    return plaintext;
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { ...AES_GCM, iv: iv as unknown as BufferSource },
    key,
    encoder.encode(plaintext) as unknown as BufferSource,
  );
  return `${b64urlFromBytes(iv)}.${b64urlFromBytes(new Uint8Array(cipher))}`;
};

const open = async (key: CryptoKey | null, stored: string): Promise<string> => {
  if (!key) {
    return stored;
  }
  const [iv, cipher] = stored.split(".");
  const plain = await crypto.subtle.decrypt(
    { ...AES_GCM, iv: bytesFromB64url(iv) as unknown as BufferSource },
    key,
    bytesFromB64url(cipher) as unknown as BufferSource,
  );
  return decoder.decode(plain);
};

// Build an OAuth token store. `encKeyRaw` (CONNECTORS_TOKEN_ENC_KEY) enables
// application-level AES-GCM on the stored token values; the key is imported once.
export const createOAuthTokenStore = (
  kv: KeyValueStore,
  encKeyRaw?: string,
): OAuthTokenStore => {
  let keyPromise: Promise<CryptoKey | null> | null = null;
  const encKey = (): Promise<CryptoKey | null> =>
    (keyPromise ??= encKeyRaw ? importEncKey(encKeyRaw) : Promise.resolve(null));
  const keyOf = (connectorId: string, subject: string) => `${OAUTH_PREFIX}${connectorId}:${subject}`;
  return {
    get: async (connectorId, subject) => {
      const raw = await kv.read(keyOf(connectorId, subject));
      if (!raw) {
        return null;
      }
      try {
        return JSON.parse(await open(await encKey(), raw)) as StoredOAuthToken;
      } catch (error) {
        logger.warn("connector_oauth_decode_failed", { connectorId, error: errorMessage(error) });
        return null;
      }
    },
    put: async (connectorId, subject, token) => {
      await kv.write(keyOf(connectorId, subject), await seal(await encKey(), JSON.stringify(token)));
    },
    remove: async (connectorId, subject) => {
      await kv.remove(keyOf(connectorId, subject));
    },
  };
};
