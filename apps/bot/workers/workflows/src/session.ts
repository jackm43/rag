import { DurableObject } from "cloudflare:workers";
import type { DiscordInteraction, Env } from "../../../contracts";
import { runDeferredCommandByName } from "../../../lib/domain/commands/session-run";

// Matches the Discord interaction-token follow-up window: past this the token
// is dead (a replay could never produce a real edit), so the dedupe marker is
// swept and DO storage never accumulates.
const SESSION_TTL_MS = 15 * 60 * 1000;
const PROCESSED_KEY = "processed-at";

// One Durable Object per interaction (idFromName(interactionToken)), hosted by
// the workflows worker. It runs a deferred-inline command to completion and
// edits the original interaction response as the `workflows` principal — this
// worker holds EGRESS + WORKFLOWS_SIGNING_KEY, which the gateway ingress does
// not, so the deferred reply can only be sent from here. The gateway verified
// the Discord signature before kicking us and reaches us over a binding-scoped
// RPC, so the call itself is trusted. Idempotent: Discord may retry the initial
// interaction POST, and both retries address the same DO.
export class InteractionSession extends DurableObject<Env> {
  async runDeferredCommand(interaction: DiscordInteraction, commandName: string): Promise<void> {
    if (!(await this.claim())) {
      return;
    }
    await runDeferredCommandByName(interaction, commandName, this.env);
  }

  // First caller wins; duplicate deliveries return false. The marker self-expires
  // via the alarm so per-interaction storage is reclaimed after the token dies.
  private async claim(): Promise<boolean> {
    if ((await this.ctx.storage.get<number>(PROCESSED_KEY)) !== undefined) {
      return false;
    }
    const now = Date.now();
    await this.ctx.storage.put(PROCESSED_KEY, now);
    await this.ctx.storage.setAlarm(now + SESSION_TTL_MS);
    return true;
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
