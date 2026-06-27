import { DurableObject } from "cloudflare:workers";
import type { GatewayHelloData, GatewayReadyDispatchData } from "discord-api-types/gateway/v10";

import { errorMessage, logger } from "./logger";
import { handleGatewayMessageCreate } from "./mention";
import type { Env } from "./types";
import { isDiscordMessage } from "./validation";

type DiscordGatewayPayload = {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
};

export type DiscordGatewayHealth = {
  connected: boolean;
  resumable: boolean;
};

const DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const DISCORD_GATEWAY_OPCODE_DISPATCH = 0;
const DISCORD_GATEWAY_OPCODE_HEARTBEAT = 1;
const DISCORD_GATEWAY_OPCODE_IDENTIFY = 2;
const DISCORD_GATEWAY_OPCODE_RESUME = 6;
const DISCORD_GATEWAY_OPCODE_RECONNECT = 7;
const DISCORD_GATEWAY_OPCODE_INVALID_SESSION = 9;
const DISCORD_GATEWAY_OPCODE_HELLO = 10;
const DISCORD_GATEWAY_OPCODE_HEARTBEAT_ACK = 11;
const DISCORD_GATEWAY_EVENT_READY = "READY";
const DISCORD_GATEWAY_EVENT_MESSAGE_CREATE = "MESSAGE_CREATE";
const GATEWAY_INTENTS = (1 << 9) | (1 << 12) | (1 << 15);
const GATEWAY_ENABLED_KEY = "gatewayEnabled";
const GATEWAY_WATCHDOG_INTERVAL_MS = 60_000;

const objectFrom = (value: unknown) =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : null;

const isGatewayPayload = (value: unknown): value is DiscordGatewayPayload => {
  const payload = objectFrom(value);
  return (
    payload !== null &&
    typeof payload.op === "number" &&
    (payload.s === undefined || payload.s === null || typeof payload.s === "number") &&
    (payload.t === undefined || payload.t === null || typeof payload.t === "string")
  );
};

const isGatewayHello = (value: unknown): value is GatewayHelloData => {
  const hello = objectFrom(value);
  return hello !== null && typeof hello.heartbeat_interval === "number" && hello.heartbeat_interval > 0;
};

const isGatewayReady = (value: unknown): value is GatewayReadyDispatchData => {
  const ready = objectFrom(value);
  const user = objectFrom(ready?.user);
  return (
    ready !== null &&
    typeof ready.session_id === "string" &&
    (ready.resume_gateway_url === undefined || typeof ready.resume_gateway_url === "string") &&
    (ready.user === undefined || (user !== null && typeof user.id === "string"))
  );
};

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

    if (payload.op === DISCORD_GATEWAY_OPCODE_HELLO && isGatewayHello(payload.d)) {
      this.startHeartbeat(payload.d);
      this.identifyOrResume();
      return;
    }

    if (payload.op === DISCORD_GATEWAY_OPCODE_HEARTBEAT_ACK) {
      this.heartbeatAcknowledged = true;
      return;
    }

    if (payload.op === DISCORD_GATEWAY_OPCODE_HEARTBEAT) {
      this.sendHeartbeat();
      return;
    }

    if (payload.op === DISCORD_GATEWAY_OPCODE_RECONNECT) {
      this.reconnect();
      return;
    }

    if (payload.op === DISCORD_GATEWAY_OPCODE_INVALID_SESSION) {
      if (payload.d !== true) {
        this.sessionId = null;
        this.resumeGatewayUrl = null;
        this.lastSequence = null;
      }
      this.reconnect();
      return;
    }

    if (payload.op !== DISCORD_GATEWAY_OPCODE_DISPATCH) {
      return;
    }

    if (payload.t === DISCORD_GATEWAY_EVENT_READY && isGatewayReady(payload.d)) {
      const ready = payload.d;
      this.sessionId = ready.session_id;
      this.resumeGatewayUrl = ready.resume_gateway_url ?? this.resumeGatewayUrl;
      this.botUserId = ready.user?.id ?? this.botUserId;
      logger.info("gateway_ready", { resumable: Boolean(this.resumeGatewayUrl) });
      return;
    }

    if (payload.t === DISCORD_GATEWAY_EVENT_MESSAGE_CREATE && isDiscordMessage(payload.d)) {
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
        op: DISCORD_GATEWAY_OPCODE_RESUME,
        d: {
          token: this.env.DISCORD_BOT_TOKEN,
          session_id: this.sessionId,
          seq: this.lastSequence,
        },
      });
      return;
    }

    this.send({
      op: DISCORD_GATEWAY_OPCODE_IDENTIFY,
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

  private startHeartbeat(hello: GatewayHelloData) {
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
    this.send({ op: DISCORD_GATEWAY_OPCODE_HEARTBEAT, d: this.lastSequence });
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
