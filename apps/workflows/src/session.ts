import { DurableObject } from "cloudflare:workers";
import type { DiscordInteraction, Env, MessageReceivedJob } from "@rag/discord/contracts";
import { runInteractionSession } from "@rag/discord/commands/session-run";
import { processMessageReceivedJob } from "@rag/discord/domain/consumer";

// Matches the Discord interaction-token follow-up window: past this the token
// is dead (a replay could never produce a real edit), so the dedupe marker is
// swept and DO storage never accumulates.
const SESSION_TTL_MS = 15 * 60 * 1000;
const PROCESSED_KEY = "processed-at";

// One Durable Object per interaction (idFromName(interactionToken)), hosted by
// the workflows worker. It runs the command to completion and edits the
// original interaction response as the `workflows` principal — this worker
// holds EGRESS + WORKFLOWS_SIGNING_KEY, which the webhooks ingress does not, so
// the deferred reply can only be sent from here. The webhooks ingress has
// already verified the Discord signature and reaches us over a binding-scoped
// RPC, so the call itself is trusted. Idempotent: Discord may retry the initial
// interaction POST, and both retries address the same DO.
export class InteractionSession extends DurableObject<Env> {
  // Full dispatch: the webhooks ingress forwards a verified interaction and the
  // DO owns the entire pre-flight + handler (all commands deferred), so the
  // ingress carries no bot domain code.
  async run(interaction: DiscordInteraction): Promise<void> {
    if (!(await this.claim())) {
      return;
    }
    await runInteractionSession(interaction, this.env);
  }

  // Mentions share this processor DO, keyed by idFromName(messageId). claim() is
  // the durable, per-message idempotency guard: a MESSAGE_CREATE that Discord
  // redelivers on a gateway reconnect/resume addresses the same DO and is
  // dropped, so a mention replies exactly once regardless of reconnect churn.
  async runMention(job: MessageReceivedJob): Promise<void> {
    if (!(await this.claim())) {
      return;
    }
    await processMessageReceivedJob(job, this.env, Date.now());
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
