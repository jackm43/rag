import { DurableObject } from "cloudflare:workers";

import type { Env } from "../../../../packages/contracts/types";

// Strongly-consistent DPoP jti replay cache. A Durable Object (not KV) because
// replay protection needs an atomic check-and-record: the DO is single-threaded
// per instance, so `seenBefore` reads and writes without a race, and there is
// no eventual-consistency / write-visibility window in which a replay could
// slip through (KV's read-after-write is not immediate across the edge).
//
// A single named instance ("dpop-replay") serializes all checks. For a dev tool
// the volume is trivial; if it ever grew, shard by jkt (one instance per key)
// to parallelize while keeping each key's jtis on one instance.
//
// Entries expire lazily via an alarm: each recorded jti stores its absolute
// expiry, the alarm sweeps expired keys and reschedules for the next one, so
// storage stays bounded without a per-request scan.
export class DpopReplay extends DurableObject<Env> {
  async seenBefore(jti: string, ttlSeconds: number): Promise<boolean> {
    const key = `jti:${jti}`;
    const now = Date.now();
    const existing = await this.ctx.storage.get<number>(key);
    if (typeof existing === "number" && existing > now) {
      // Still within its acceptance window: a replay.
      return true;
    }
    const expiresAt = now + ttlSeconds * 1000;
    await this.ctx.storage.put(key, expiresAt);
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null) {
      await this.ctx.storage.setAlarm(expiresAt + 1000);
    }
    return false;
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const entries = await this.ctx.storage.list<number>({ prefix: "jti:" });
    let next: number | null = null;
    for (const [key, expiresAt] of entries) {
      if (expiresAt <= now) {
        await this.ctx.storage.delete(key);
      } else {
        next = next === null ? expiresAt : Math.min(next, expiresAt);
      }
    }
    if (next !== null) {
      await this.ctx.storage.setAlarm(next + 1000);
    }
  }
}
