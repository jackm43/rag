import { DurableObject } from "cloudflare:workers";

import { errorMessage, logger } from "./logger";
import { handleGatewayMessageCreate } from "./mention";
import type { Env } from "./types";
import { isDiscordMessage, isRecord } from "./validation";

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
const GATEWAY_WATCHDOG_INTERVAL_MS = 60_000;

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
  const id = env.DISCORD_GATEWAY.idFromName("discord-gateway");
  return env.DISCORD_GATEWAY.get(id);
};

export const startGateway = async (env: Env) => gatewayStub(env).start();

export const getGatewayHealth = async (env: Env) => gatewayStub(env).health();

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
    await this.enableGateway();
    this.connectGateway();
    return { ok: true };
  }

  async alarm() {
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
      void this.handleMessage(event);
    });
    webSocket.addEventListener("close", () => {
      this.clearHeartbeat();
      this.scheduleReconnect();
    });
    webSocket.addEventListener("error", () => {
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
      try {
        await handleGatewayMessageCreate(payload.d, this.env, this.botUserId);
      } catch (error) {
        logger.error("gateway_message_create_failed", { error: errorMessage(error) });
      }
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
    if (this.webSocket?.readyState === WebSocket.OPEN || this.webSocket?.readyState === WebSocket.CONNECTING) {
      this.webSocket.close(4000, "reconnect");
    }
    this.webSocket = null;
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
