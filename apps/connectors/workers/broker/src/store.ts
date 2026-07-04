import { DurableObject } from "cloudflare:workers";

import type { Env } from "../../../contracts";

// The broker's grant/token store as a Durable Object: strongly consistent and
// persistent across isolates, so a handle minted in one isolate resolves in
// another (an in-memory map could not). Durable Object storage is encrypted at
// rest by the platform. It is a dumb key/value substrate — grant/OAuth-token
// semantics (key namespacing, JSON, optional envelope encryption) live in
// apps/connectors/lib/store.ts, which this backs.
//
// TTL is lazy: a written entry records its own expiry and read() drops it once
// past. Grants are small and short-lived, so lazy expiry needs no alarm sweep;
// the value never surfaces once expired (defence in depth is also enforced by
// the grant store's own expiry re-check).
type StoredEntry = { value: string; expiresAt?: number };

export class ConnectorStore extends DurableObject<Env> {
  async read(key: string): Promise<string | null> {
    const entry = await this.ctx.storage.get<StoredEntry>(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      await this.ctx.storage.delete(key);
      return null;
    }
    return entry.value;
  }

  async write(key: string, value: string, ttlMs?: number): Promise<void> {
    await this.ctx.storage.put(key, {
      value,
      ...(ttlMs !== undefined ? { expiresAt: Date.now() + ttlMs } : {}),
    } satisfies StoredEntry);
  }

  async remove(key: string): Promise<void> {
    await this.ctx.storage.delete(key);
  }
}
