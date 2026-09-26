import { DurableObject } from "cloudflare:workers";

import { handleMessageCreate } from "../events/messageCreate";
import { isDiscordMessage, isRecord, type DiscordMessage } from "../lib/contracts";
import { errorMessage, logger } from "../lib/logger";
import type { Env } from "../env";

type DiscordGatewayPayload = {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
};

type DiscordGatewayHello = {
  heartbeat_interval: number;
};

type DiscordGatewayReady = {
  session_id: string;
  resume_gateway_url?: string;
  user?: {
    id: string;
  };
};

export type DiscordGatewayHealth = {
  connected: boolean;
  resumable: boolean;
};

// Resume URLs omit the version/encoding query; reconnects need it too.
const GATEWAY_QUERY = "/?v=10&encoding=json";
const DISCORD_GATEWAY_URL = `wss://gateway.discord.gg${GATEWAY_QUERY}`;
const GUILD_MESSAGES_INTENT = 1 << 9;
const DIRECT_MESSAGES_INTENT = 1 << 12;
const MESSAGE_CONTENT_INTENT = 1 << 15;
const GATEWAY_INTENTS = GUILD_MESSAGES_INTENT | DIRECT_MESSAGES_INTENT | MESSAGE_CONTENT_INTENT;
const GATEWAY_ENABLED_KEY = "gatewayEnabled";
// Only manual start clears an operator stop; cron must respect the kill switch.
const GATEWAY_STOPPED_KEY = "gatewayStopped";
const GATEWAY_WATCHDOG_INTERVAL_MS = 5 * 60_000;
// Persist dedupe across reconnects/evictions; the watchdog expires old markers.
const PROCESSED_KEY_PREFIX = "processed:";
const PROCESSED_TTL_MS = 24 * 60 * 60_000;
// The in-memory race guard is bounded; storage is the durable record.
const PROCESSED_SET_MAX = 2000;
// Fatal authentication/shard/version/intent errors disable 5s retries.
// Only the next cron tick or manual start retries these failures.
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
// Invalid seq / session timed out: the session is gone, so resume state must be
// dropped and the reconnect must send a fresh IDENTIFY.
const NON_RESUMABLE_CLOSE_CODES = new Set([4007, 4009]);

const isGatewayPayload = (value: unknown): value is DiscordGatewayPayload =>
  isRecord(value) &&
  typeof value.op === "number" &&
  (value.s === undefined || value.s === null || typeof value.s === "number") &&
  (value.t === undefined || value.t === null || typeof value.t === "string");

const isGatewayHello = (value: unknown): value is DiscordGatewayHello =>
  isRecord(value) && typeof value.heartbeat_interval === "number" && value.heartbeat_interval > 0;

const isGatewayReady = (value: unknown): value is DiscordGatewayReady =>
  isRecord(value) &&
  typeof value.session_id === "string" &&
  (value.resume_gateway_url === undefined || typeof value.resume_gateway_url === "string") &&
  (value.user === undefined ||
    (isRecord(value.user) && typeof value.user.id === "string"));

// Old singleton names must self-decommission to prevent duplicate Discord sessions.
const GATEWAY_DO_NAME = "discord-gateway-v2";

const gatewayStub = (env: Env) => {
  const id = env.DISCORD_GATEWAY.idFromName(GATEWAY_DO_NAME);
  return env.DISCORD_GATEWAY.get(id) as unknown as DiscordGatewayStub;
};

// The DO's RPC surface, exposed over the DISCORD_GATEWAY binding.
type DiscordGatewayStub = {
  start(): Promise<{ ok: true }>;
  stop(): Promise<{ ok: true }>;
  health(): Promise<DiscordGatewayHealth>;
  ensureConnected(): Promise<{ ok: boolean; stopped?: boolean }>;
};

export const startGateway = async (env: Env) => gatewayStub(env).start();

export const stopGateway = async (env: Env) => gatewayStub(env).stop();

export const getGatewayHealth = async (env: Env) => gatewayStub(env).health();

// Cron self-heals the connection unless explicitly stopped (or unbound in tests).
export const ensureGatewayConnected = async (env: Env) => {
  if (!env.DISCORD_GATEWAY) {
    return { ok: false as const };
  }
  return gatewayStub(env).ensureConnected();
};

export class DiscordGateway extends DurableObject<Env> {
  private webSocket: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSequence: number | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private botUserId: string | null = null;
  private heartbeatAcknowledged = true;
  // Claim synchronously before the durable check so concurrent deliveries cannot race.
  private readonly processedMessageIds = new Set<string>();

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.ctx.blockConcurrencyWhile?.(async () => {
      if (!this.isCanonicalInstance()) {
        await this.decommission();
        return;
      }
      if (await this.isGatewayEnabled()) {
        await this.scheduleWatchdog();
        this.connectGateway();
      }
    });
  }

  // True only for the object addressed by idFromName(GATEWAY_DO_NAME). Stale
  // objects under older names must never hold a gateway session.
  private isCanonicalInstance() {
    // Unit tests construct the DO with a mock env without the binding; treat
    // that as canonical so the mock's behavior is unchanged.
    if (!this.env.DISCORD_GATEWAY?.idFromName) {
      return true;
    }
    return this.ctx.id.equals(this.env.DISCORD_GATEWAY.idFromName(GATEWAY_DO_NAME));
  }

  // Permanently retire a non-canonical instance: wipe the persisted flags and
  // dedupe markers and cancel the alarm chain, so nothing ever wakes it again.
  private async decommission() {
    logger.warn("gateway_stale_instance_decommissioned", { id: this.ctx.id.toString() });
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async health(): Promise<DiscordGatewayHealth> {
    return {
      connected: this.webSocket?.readyState === WebSocket.OPEN,
      resumable: Boolean(this.sessionId && this.resumeGatewayUrl),
    };
  }

  async start() {
    // Coalesce independent writes before connecting; manual start clears the stop.
    await Promise.all([
      this.ctx.storage.delete(GATEWAY_STOPPED_KEY),
      this.enableGateway(),
    ]);
    this.connectGateway();
    return { ok: true as const };
  }

  // Idempotent cron entrypoint; respect explicit operator stops.
  async ensureConnected() {
    if ((await this.ctx.storage.get<boolean>(GATEWAY_STOPPED_KEY)) === true) {
      return { ok: false, stopped: true };
    }
    await this.enableGateway();
    this.connectGateway();
    return { ok: true };
  }

  // Persist the kill switch and discard the session; later start uses fresh IDENTIFY.
  async stop() {
    // Coalesce distinct writes while tearing down the socket; await durability before returning.
    const persisted = Promise.all([
      this.ctx.storage.delete(GATEWAY_ENABLED_KEY),
      this.ctx.storage.put(GATEWAY_STOPPED_KEY, true),
      this.ctx.storage.deleteAlarm(),
    ]);

    this.clearReconnect();
    this.closeSocket(1000, "stop");

    this.resetSession();
    await persisted;
    return { ok: true as const };
  }

  private resetSession() {
    this.sessionId = null;
    this.resumeGatewayUrl = null;
    this.lastSequence = null;
  }

  async alarm() {
    if (!this.isCanonicalInstance()) {
      await this.decommission();
      return;
    }
    await this.pruneProcessedMarkers();
    if (!(await this.isGatewayEnabled())) {
      return;
    }

    this.connectGateway();
    await this.scheduleWatchdog();
  }

  private async pruneProcessedMarkers() {
    const cutoff = Date.now() - PROCESSED_TTL_MS;
    const markers = await this.ctx.storage.list<number>({ prefix: PROCESSED_KEY_PREFIX });
    const stale = [...markers].filter(([, at]) => at <= cutoff).map(([key]) => key);
    if (stale.length > 0) {
      await this.ctx.storage.delete(stale);
    }
  }

  private async enableGateway() {
    // Independent write + alarm: coalesce under the output gate.
    await Promise.all([
      this.ctx.storage.put(GATEWAY_ENABLED_KEY, true),
      this.scheduleWatchdog(),
    ]);
  }

  private async isGatewayEnabled() {
    return (await this.ctx.storage.get<boolean>(GATEWAY_ENABLED_KEY)) === true;
  }

  private scheduleWatchdog() {
    return this.ctx.storage.setAlarm(Date.now() + GATEWAY_WATCHDOG_INTERVAL_MS);
  }

  private connectGateway() {
    if (this.webSocket?.readyState === WebSocket.OPEN || this.webSocket?.readyState === WebSocket.CONNECTING) {
      return;
    }

    this.clearReconnect();

    const webSocket = new WebSocket(
      this.resumeGatewayUrl ? `${this.resumeGatewayUrl}${GATEWAY_QUERY}` : DISCORD_GATEWAY_URL,
    );
    this.webSocket = webSocket;
    webSocket.addEventListener("message", (event) => {
      // Ignore discarded sockets to prevent duplicate message processing.
      if (this.webSocket !== webSocket) {
        return;
      }
      void this.handleMessage(event);
    });
    // A deliberate close must not schedule a reconnect.
    webSocket.addEventListener("close", (event) => {
      if (this.webSocket !== webSocket) {
        return;
      }
      this.clearHeartbeat();
      const code = (event as Partial<CloseEvent>).code;
      if (code !== undefined && FATAL_CLOSE_CODES.has(code)) {
        logger.error("gateway_fatal_close", { code });
        this.webSocket = null;
        this.resetSession();
        void Promise.all([
          this.ctx.storage.delete(GATEWAY_ENABLED_KEY),
          this.ctx.storage.deleteAlarm(),
        ]).catch((error) => {
          logger.error("gateway_fatal_close_disable_failed", { error: errorMessage(error) });
        });
        return;
      }
      if (code !== undefined && NON_RESUMABLE_CLOSE_CODES.has(code)) {
        this.resetSession();
      }
      this.scheduleReconnect();
    });
    webSocket.addEventListener("error", () => {
      if (this.webSocket !== webSocket) {
        return;
      }
      this.scheduleReconnect();
    });
  }

  private async handleMessage(event: MessageEvent) {
    let payload: DiscordGatewayPayload;
    try {
      const parsed = JSON.parse(String(event.data));
      if (!isGatewayPayload(parsed)) {
        logger.warn("gateway_payload_invalid");
        return;
      }
      payload = parsed;
    } catch (error) {
      logger.warn("gateway_payload_parse_failed", { error: errorMessage(error) });
      return;
    }

    if (typeof payload.s === "number") {
      this.lastSequence = payload.s;
    }

    switch (payload.op) {
      case 10:
        if (isGatewayHello(payload.d)) {
          this.startHeartbeat(payload.d);
          this.identifyOrResume();
        }
        return;
      case 11:
        this.heartbeatAcknowledged = true;
        return;
      case 1:
        this.sendHeartbeat();
        return;
      case 9:
        if (payload.d !== true) this.resetSession();
        this.reconnect();
        return;
      case 7:
        this.reconnect();
        return;
      case 0: break;
      default: return;
    }

    if (payload.t === "READY" && isGatewayReady(payload.d)) {
      const ready = payload.d;
      this.sessionId = ready.session_id;
      this.resumeGatewayUrl = ready.resume_gateway_url ?? this.resumeGatewayUrl;
      this.botUserId = ready.user?.id ?? this.botUserId;
      logger.info("gateway_ready", { resumable: Boolean(this.resumeGatewayUrl) });
      return;
    }

    if (payload.t === "MESSAGE_CREATE" && isDiscordMessage(payload.d)) {
      // Slow or failed replies must not delay heartbeats; processMention contains errors.
      void this.processMention(payload.d);
    }
  }

  // Claim in memory before awaiting storage; contain failures to preserve the socket.
  private async processMention(message: DiscordMessage) {
    const messageId = message.id;
    if (this.processedMessageIds.has(messageId)) {
      return;
    }
    this.processedMessageIds.add(messageId);
    if (this.processedMessageIds.size > PROCESSED_SET_MAX) {
      const oldest = this.processedMessageIds.values().next().value;
      if (oldest !== undefined) {
        this.processedMessageIds.delete(oldest);
      }
    }

    const key = `${PROCESSED_KEY_PREFIX}${messageId}`;
    try {
      if ((await this.ctx.storage.get<number>(key)) !== undefined) {
        return;
      }
      await this.ctx.storage.put(key, Date.now());
      await handleMessageCreate(message, this.env, this.botUserId);
    } catch (error) {
      logger.error("gateway_message_create_failed", { error: errorMessage(error) });
    }
  }

  private identifyOrResume() {
    if (this.sessionId && this.resumeGatewayUrl) {
      this.send({
        op: 6,
        d: {
          token: this.env.DISCORD_BOT_TOKEN,
          session_id: this.sessionId,
          seq: this.lastSequence,
        },
      });
      return;
    }

    this.send({
      op: 2,
      d: {
        token: this.env.DISCORD_BOT_TOKEN,
        intents: GATEWAY_INTENTS,
        properties: {
          os: "linux",
          browser: "ragbot-worker",
          device: "ragbot-worker",
        },
      },
    });
  }

  private startHeartbeat(hello: DiscordGatewayHello) {
    this.clearHeartbeat();
    this.heartbeatAcknowledged = true;
    this.sendHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.heartbeatAcknowledged) {
        this.reconnect();
        return;
      }
      this.sendHeartbeat();
    }, hello.heartbeat_interval);
  }

  private sendHeartbeat() {
    this.heartbeatAcknowledged = false;
    this.send({ op: 1, d: this.lastSequence });
  }

  private send(payload: unknown) {
    if (this.webSocket?.readyState === WebSocket.OPEN) {
      this.webSocket.send(JSON.stringify(payload));
    }
  }

  private closeSocket(code: number, reason: string) {
    this.clearHeartbeat();
    const socket = this.webSocket;
    this.webSocket = null; // Ignore close events from the discarded socket.
    if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
      socket.close(code, reason);
    }
  }

  private clearReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private reconnect() {
    this.closeSocket(4000, "reconnect");
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== undefined) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectGateway();
    }, 5_000);
  }

  private clearHeartbeat() {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }
}
