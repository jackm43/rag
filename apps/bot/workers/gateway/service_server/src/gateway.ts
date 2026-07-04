import { DurableObject } from "cloudflare:workers";

import { errorMessage, logger } from "@rag/logger";
import { handleGatewayMessageCreate } from "../../../../lib/domain/mention";
import type { Env } from "../../../../contracts";
import { isDiscordMessage } from "../../../../contracts";
import { isRecord } from "@rag/contracts-core";

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

const DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const GUILD_MESSAGES_INTENT = 1 << 9;
const DIRECT_MESSAGES_INTENT = 1 << 12;
const MESSAGE_CONTENT_INTENT = 1 << 15;
const GATEWAY_INTENTS = GUILD_MESSAGES_INTENT | DIRECT_MESSAGES_INTENT | MESSAGE_CONTENT_INTENT;
const GATEWAY_ENABLED_KEY = "gatewayEnabled";
// Set only by an explicit operator stop(). ensureConnected() (called by the
// cron trigger and opportunistically on interactions) refuses to reconnect
// while this is set, so automatic wake-ups can never resurrect a deliberate
// kill switch. A manual start() clears it.
const GATEWAY_STOPPED_KEY = "gatewayStopped";
const GATEWAY_WATCHDOG_INTERVAL_MS = 5 * 60_000;
// Message-dedupe window: Discord (or a briefly overlapping session after a
// reconnect) can deliver the same MESSAGE_CREATE more than once. Enqueue each
// message id at most once within this window so a mention never double-replies.
// Duplicates always arrive within seconds; entries are swept in alarm().
const MESSAGE_DEDUPE_TTL_MS = 60_000;
const MESSAGE_SEEN_PREFIX = "msg:";

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

const gatewayStub = (env: Env) => {
  const id = env.DISCORD_GATEWAY.idFromName("discord-gateway-v2");
  return env.DISCORD_GATEWAY.get(id);
};

export const startGateway = async (env: Env) => gatewayStub(env).start();

export const stopGateway = async (env: Env) => gatewayStub(env).stop();

export const getGatewayHealth = async (env: Env) => gatewayStub(env).health();

// Idempotently ensure the gateway websocket is up. Called by the worker's cron
// trigger and opportunistically on each interaction, so the connection
// self-establishes after a deploy and self-heals without any manual
// /gateway/start. A no-op while the operator has explicitly stopped it, or when
// the DO binding is absent (e.g. unit tests with a mock env).
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

  constructor(
    state: DurableObjectState,
    env: Env,
  ) {
    super(state, env);
    this.ctx.blockConcurrencyWhile?.(async () => {
      if (await this.isGatewayEnabled()) {
        await this.scheduleWatchdog();
        this.connectGateway();
      }
    });
  }

  async health(): Promise<DiscordGatewayHealth> {
    return {
      connected: this.webSocket?.readyState === WebSocket.OPEN,
      resumable: Boolean(this.sessionId && this.resumeGatewayUrl),
    };
  }

  async start() {
    // A manual start clears any operator stop so automatic wake-ups resume.
    await this.ctx.storage.delete(GATEWAY_STOPPED_KEY);
    await this.enableGateway();
    this.connectGateway();
    return { ok: true };
  }

  // Auto-connect entrypoint for the cron trigger and interaction webhook. Unless
  // the operator has explicitly stopped the gateway, enable and connect
  // (both idempotent: connectGateway() returns early when already open).
  async ensureConnected() {
    if ((await this.ctx.storage.get<boolean>(GATEWAY_STOPPED_KEY)) === true) {
      return { ok: false, stopped: true };
    }
    await this.enableGateway();
    this.connectGateway();
    return { ok: true };
  }

  // Operator kill switch: clear the enabled flag, cancel the watchdog alarm,
  // close the socket, and forget the resume state so a later start begins
  // with a fresh IDENTIFY. The alarm handler also checks isGatewayEnabled,
  // so even a racing alarm cannot resurrect a stopped gateway.
  async stop() {
    await this.ctx.storage.delete(GATEWAY_ENABLED_KEY);
    // Mark an explicit operator stop so the cron/interaction ensureConnected()
    // cannot bring it back up until a manual start().
    await this.ctx.storage.put(GATEWAY_STOPPED_KEY, true);
    await this.ctx.storage.deleteAlarm();

    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.clearHeartbeat();

    const webSocket = this.webSocket;
    this.webSocket = null;
    if (webSocket?.readyState === WebSocket.OPEN || webSocket?.readyState === WebSocket.CONNECTING) {
      webSocket.close(1000, "stop");
    }

    this.sessionId = null;
    this.resumeGatewayUrl = null;
    this.lastSequence = null;
    return { ok: true };
  }

  async alarm() {
    await this.sweepSeenMessages();
    if (!(await this.isGatewayEnabled())) {
      return;
    }

    this.connectGateway();
    await this.scheduleWatchdog();
  }

  private async enableGateway() {
    await this.ctx.storage.put(GATEWAY_ENABLED_KEY, true);
    await this.scheduleWatchdog();
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

    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    const webSocket = new WebSocket(this.resumeGatewayUrl ?? DISCORD_GATEWAY_URL);
    this.webSocket = webSocket;
    webSocket.addEventListener("message", (event) => {
      // Only the current socket handles events. A socket this object has already
      // let go of (a reconnect or a connect race that opened a second socket)
      // must not keep processing — otherwise it double-enqueues every message.
      // The close/error handlers below guard the same way.
      if (this.webSocket !== webSocket) {
        return;
      }
      void this.handleMessage(event);
    });
    // Ignore events from sockets this object has already let go of (stop()
    // and reconnect() null out this.webSocket first), so a deliberate close
    // does not schedule a reconnect.
    webSocket.addEventListener("close", () => {
      if (this.webSocket !== webSocket) {
        return;
      }
      this.clearHeartbeat();
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

    if (payload.op === 10 && isGatewayHello(payload.d)) {
      this.startHeartbeat(payload.d);
      this.identifyOrResume();
      return;
    }

    if (payload.op === 11) {
      this.heartbeatAcknowledged = true;
      return;
    }

    if (payload.op === 1) {
      this.sendHeartbeat();
      return;
    }

    if (payload.op === 7) {
      this.reconnect();
      return;
    }

    if (payload.op === 9) {
      if (payload.d !== true) {
        this.sessionId = null;
        this.resumeGatewayUrl = null;
        this.lastSequence = null;
      }
      this.reconnect();
      return;
    }

    if (payload.op !== 0) {
      return;
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
      // Idempotency across duplicate deliveries: enqueue each message id once.
      if (!(await this.firstSeenMessage(payload.d.id))) {
        return;
      }
      try {
        await handleGatewayMessageCreate(payload.d, this.env, this.botUserId);
      } catch (error) {
        logger.error("gateway_message_create_failed", { error: errorMessage(error) });
      }
    }
  }

  // Records a message id with a short TTL; returns false when already seen (a
  // duplicate delivery). One DiscordGateway DO instance handles every gateway
  // event, so this dedupes across overlapping sockets/sessions too.
  private async firstSeenMessage(messageId: string): Promise<boolean> {
    const key = `${MESSAGE_SEEN_PREFIX}${messageId}`;
    const now = Date.now();
    const expiresAt = await this.ctx.storage.get<number>(key);
    if (expiresAt !== undefined && expiresAt > now) {
      return false;
    }
    await this.ctx.storage.put(key, now + MESSAGE_DEDUPE_TTL_MS);
    return true;
  }

  private async sweepSeenMessages(): Promise<void> {
    const now = Date.now();
    const entries = await this.ctx.storage.list<number>({ prefix: MESSAGE_SEEN_PREFIX });
    const expired: string[] = [];
    for (const [key, expiresAt] of entries) {
      if (expiresAt <= now) {
        expired.push(key);
      }
    }
    for (let i = 0; i < expired.length; i += 128) {
      await this.ctx.storage.delete(expired.slice(i, i + 128));
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

  private reconnect() {
    this.clearHeartbeat();
    const webSocket = this.webSocket;
    this.webSocket = null;
    if (webSocket?.readyState === WebSocket.OPEN || webSocket?.readyState === WebSocket.CONNECTING) {
      webSocket.close(4000, "reconnect");
    }
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
