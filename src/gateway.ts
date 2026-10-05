// One Durable Object holds Ragbot's Discord gateway session and answers its messages in-process.
import { DurableObject } from "cloudflare:workers";
import { handleMessage } from "./chat.ts";
import { dispatch } from "./commands.ts";
import { GatewayConnection, Intents, type Session } from "./lib/discord/gateway.ts";
import type { Env } from "./index.ts";

const WATCHDOG_MS = 60_000;
const SWEEP_INTERVAL_MS = 3_600_000;
const MARKER_TTL_MS = 86_400_000;

/** The singleton stub. The name and storage keys are shared with the deployed object. */
export const gateway = (env: Env) => env.DISCORD_GATEWAY.getByName("discord-gateway-v2");

export class DiscordGateway extends DurableObject<Env> {
  private sweptAt = 0;
  // Message IDs claimed in memory before any await, so duplicate deliveries cannot race.
  private readonly processed = new Set<string>();
  private readonly connection: GatewayConnection;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.connection = new GatewayConnection({
      token: env.DISCORD_BOT_TOKEN,
      intents: Intents.GUILD_MESSAGES | Intents.DIRECT_MESSAGES | Intents.MESSAGE_CONTENT,
      saveSession: (session) =>
        session ? ctx.storage.put("gatewaySession", session) : ctx.storage.delete("gatewaySession").then(() => {}),
      dispatch: (type, data) => {
        if (type === "MESSAGE_CREATE") this.onMessageCreate(data);
      },
      // Stop rapid retries after a fatal Discord response; cron or an explicit start retries.
      fatal: async () => {
        await ctx.storage.delete("gatewayEnabled");
        await ctx.storage.deleteAlarm();
      },
      background: (task) => this.background(task),
    });
    ctx.blockConcurrencyWhile(() => this.restore());
  }

  // A restarted object resumes the stored session; Discord replays the events it missed.
  private async restore() {
    const session = await this.ctx.storage.get<Session>("gatewaySession");
    if (session) this.connection.restore(session);
    if ((await this.ctx.storage.get("gatewayEnabled")) === true) {
      this.connection.enabled = true;
      await this.watchdog();
      this.background(this.connection.connect());
    }
  }

  async health() {
    return {
      connected: this.connection.connected,
      resumable: this.connection.resumable,
      stopped: (await this.ctx.storage.get("gatewayStopped")) === true,
    };
  }

  async start() {
    await this.ctx.storage.delete("gatewayStopped");
    await this.enable();
    // An operator start retries now; Discord's IDENTIFY budget is still checked.
    this.connection.resetBackoff();
    await this.connection.connect();
    return { ok: true };
  }

  async ensureConnected() {
    if ((await this.ctx.storage.get("gatewayStopped")) === true) return { ok: false, stopped: true };
    await this.enable();
    // A pending reconnect keeps its backoff.
    if (!this.connection.reconnectPending) await this.connection.connect();
    return { ok: true };
  }

  // An operator stop survives eviction and cron; the next start sends a fresh IDENTIFY.
  async stop() {
    this.connection.stop();
    await this.ctx.storage.delete("gatewayEnabled");
    await this.ctx.storage.put("gatewayStopped", true);
    await this.ctx.storage.deleteAlarm();
    return { ok: true };
  }

  async alarm() {
    try {
      if ((await this.ctx.storage.get("gatewayEnabled")) === true) {
        this.connection.enabled = true;
        // After a restart there is no timer, so this connects; a pending reconnect keeps its backoff.
        if (!this.connection.reconnectPending) await this.connection.connect();
        await this.watchdog();
      }
      await this.sweepMarkers();
    } catch {
      // The runtime drops an alarm after repeated failures; keep the watchdog alive.
      console.error("gateway_alarm_failed");
      await this.watchdog();
    }
  }

  /**
   * Run a deferred slash command here: pending work keeps a Durable Object alive for up to
   * 15 minutes, while the interaction request's waitUntil ends 30 s after its response.
   */
  async runCommand(interaction: any) {
    this.ctx.waitUntil(dispatch(this.env, interaction));
  }

  private async enable() {
    await this.ctx.storage.put("gatewayEnabled", true);
    this.connection.enabled = true;
    await this.watchdog();
  }

  private watchdog() {
    return this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
  }

  private async sweepMarkers() {
    const now = Date.now();
    if (now - this.sweptAt < SWEEP_INTERVAL_MS) return;
    this.sweptAt = now;
    const markers = await this.ctx.storage.list<number>({ prefix: "processed:" });
    const stale = [...markers].filter(([, at]) => at <= now - MARKER_TTL_MS).map(([key]) => key);
    // storage.delete accepts at most 128 keys per call.
    for (let i = 0; i < stale.length; i += 128) await this.ctx.storage.delete(stale.slice(i, i + 128));
  }

  private onMessageCreate(message: any) {
    if (this.processed.has(message.id)) return;
    this.processed.add(message.id);
    if (this.processed.size > 2000) this.processed.delete(this.processed.values().next().value!);
    this.background(this.processMessage(message));
  }

  // `processed:` markers dedupe events Discord replays after a resume.
  private async processMessage(message: any) {
    const key = `processed:${message.id}`;
    if ((await this.ctx.storage.get(key)) !== undefined) return;
    await this.ctx.storage.put(key, Date.now());
    await handleMessage(this.env, message, this.connection.botUserId);
  }

  private background(task: Promise<unknown>) {
    task.catch(() => console.error("gateway_background_failed"));
  }
}
