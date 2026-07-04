import { DurableObject } from "cloudflare:workers";

import type { Env } from "../../../../../packages/contracts/types";

// TTL'd webhook-replay dedupe store. One Durable Object per connector
// (idFromName(connectorId)), keyed by the BROKER-RETURNED provider event id —
// the id is trusted only because it came back from a valid signature, never
// read from the raw request. Strongly consistent and single-threaded per
// object, so concurrent redeliveries of the same event serialize and exactly
// one wins.
//
// Replay honesty: Stripe replays are additionally bounded broker-side by the
// signed-timestamp tolerance (a correctly-signed-but-stale delivery already
// verifies false), so this store only needs to cover the tolerance window
// there. GitHub sends NO signed timestamp — a captured delivery replays with a
// valid signature forever — so this dedupe, over the X-GitHub-Delivery id and
// this TTL, IS the replay control for GitHub. A replay older than the TTL is
// accepted again; that residual window is a deliberate storage/robustness
// trade-off, documented rather than hidden.
//
// DO storage has no per-key expiry, so entries store their own expiresAt and
// an alarm sweeps expired keys (rescheduling itself to the next expiry) so the
// store cannot grow unbounded.

// Chunk size for storage.delete(), which accepts at most 128 keys per call.
const DELETE_BATCH = 128;

export class WebhookDedupe extends DurableObject<Env> {
  // Record `key` (the provider event id) for `ttlMs`, returning true when it
  // was NOT already recorded inside its window — i.e. "process this one" —
  // and false for a duplicate. An expired leftover counts as first-seen again.
  async firstSeen(key: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const expiresAt = await this.ctx.storage.get<number>(key);
    if (expiresAt !== undefined && expiresAt > now) {
      return false;
    }
    await this.ctx.storage.put(key, now + ttlMs);
    // Sweep is best-effort housekeeping: schedule one only when none pending.
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(now + ttlMs);
    }
    return true;
  }

  // Sweep expired entries; reschedule for the soonest remaining expiry.
  async alarm(): Promise<void> {
    const now = Date.now();
    const entries = await this.ctx.storage.list<number>();
    const expired: string[] = [];
    let next: number | null = null;
    for (const [key, expiresAt] of entries) {
      if (expiresAt <= now) {
        expired.push(key);
      } else {
        next = next === null ? expiresAt : Math.min(next, expiresAt);
      }
    }
    for (let index = 0; index < expired.length; index += DELETE_BATCH) {
      await this.ctx.storage.delete(expired.slice(index, index + DELETE_BATCH));
    }
    if (next !== null) {
      await this.ctx.storage.setAlarm(next);
    }
  }
}
