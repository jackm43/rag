// One Durable Object holds Ragbot's Discord gateway session and answers its messages in-process.
import { DurableObject } from "cloudflare:workers";
import { handleMessage } from "./chat.ts";
import { gatewayBot, seconds } from "./discord.ts";
import type { Env } from "./index.ts";

const DEFAULT_URL = "wss://gateway.discord.gg";
const INTENTS = (1 << 9) | (1 << 12) | (1 << 15); // guild messages, direct messages, message content
// Authentication, sharding, version and intent errors: stop rapid retries until cron or /gateway/start.
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
// The session is gone: reconnect with a fresh IDENTIFY instead of RESUME.
const NON_RESUMABLE_CLOSE_CODES = new Set([4003, 4007, 4009]);
const WATCHDOG_MS = 60_000;
const SWEEP_INTERVAL_MS = 3_600_000;
const MARKER_TTL_MS = 86_400_000;

type Session = { sessionId: string; resumeUrl: string; sequence: number | null; botUserId: string | null };

/** The singleton stub. The name and storage keys are shared with the deployed object. */
export const gateway = (env: Env) => env.DISCORD_GATEWAY.getByName("discord-gateway-v2");

// IDENTIFY and RESUME carry the bot token, so only ever connect to Discord gateway hosts.
function gatewayUrl(url: string | null) {
  try {
    const parsed = new URL(url ?? "");
    if (parsed.protocol === "wss:" && parsed.hostname.endsWith(".discord.gg")) return url!.replace(/\/+$/, "");
  } catch {
    // Fall back to the default host.
  }
  return DEFAULT_URL;
}

export class DiscordGateway extends DurableObject<Env> {
  private socket: WebSocket | null = null;
  private heartbeatTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private connecting: Promise<void> = Promise.resolve();
  private enabled = false;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private sequence: number | null = null;
  private savedSequence: number | null = null;
  private botUserId: string | null = null;
  private heartbeatAcknowledged = true;
  private attempts = 0;
  private identifyAfter = 0;
  private sweptAt = 0;
  // Message IDs claimed in memory before any await, so duplicate deliveries cannot race.
  private readonly processed = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(() => this.restore());
  }

  // A restarted object resumes the stored session; Discord replays the events it missed.
  private async restore() {
    const session = await this.ctx.storage.get<Session>("gatewaySession");
    if (session) {
      this.sessionId = session.sessionId;
      this.resumeUrl = session.resumeUrl;
      this.sequence = this.savedSequence = session.sequence;
      this.botUserId = session.botUserId;
    }
    if ((await this.ctx.storage.get("gatewayEnabled")) === true) {
      this.enabled = true;
      await this.watchdog();
      this.background(this.connectGateway());
    }
  }

  async health() {
    return {
      connected: this.socket?.readyState === WebSocket.OPEN,
      resumable: Boolean(this.sessionId && this.resumeUrl),
      stopped: (await this.ctx.storage.get("gatewayStopped")) === true,
    };
  }

  async start() {
    await this.ctx.storage.delete("gatewayStopped");
    await this.enable();
    // An operator start retries now; Discord's IDENTIFY budget is still checked.
    this.attempts = 0;
    this.identifyAfter = 0;
    await this.connectGateway();
    return { ok: true };
  }

  async ensureConnected() {
    if ((await this.ctx.storage.get("gatewayStopped")) === true) return { ok: false, stopped: true };
    await this.enable();
    // A pending reconnect keeps its backoff.
    if (this.reconnectTimer === null) await this.connectGateway();
    return { ok: true };
  }

  // An operator stop survives eviction and cron; the next start sends a fresh IDENTIFY.
  async stop() {
    this.enabled = false;
    this.clearReconnect();
    this.closeSocket(1000, "stop");
    this.resetSession();
    await this.ctx.storage.delete("gatewayEnabled");
    await this.ctx.storage.put("gatewayStopped", true);
    await this.ctx.storage.deleteAlarm();
    return { ok: true };
  }

  async alarm() {
    try {
      if ((await this.ctx.storage.get("gatewayEnabled")) === true) {
        this.enabled = true;
        // After a restart there is no timer, so this connects; a pending reconnect keeps its backoff.
        if (this.reconnectTimer === null) await this.connectGateway();
        await this.watchdog();
      }
      await this.sweepMarkers();
    } catch {
      // The runtime drops an alarm after repeated failures; keep the watchdog alive.
      console.error("gateway_alarm_failed");
      await this.watchdog();
    }
  }

  private async enable() {
    await this.ctx.storage.put("gatewayEnabled", true);
    this.enabled = true;
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

  // Connection attempts run one at a time; each re-checks state, so queued calls are no-ops.
  private connectGateway() {
    const attempt = this.connecting.then(() => this.openSocket());
    this.connecting = attempt.catch(() => {});
    return attempt;
  }

  private async openSocket() {
    if (!this.enabled || (this.socket && this.socket.readyState <= WebSocket.OPEN)) return;
    this.clearReconnect();
    this.closeSocket(4000, "reconnect");
    const resuming = Boolean(this.sessionId && this.resumeUrl);
    const url = resuming ? gatewayUrl(this.resumeUrl) : await this.identifyUrl();
    if (!url) return;
    let response: Response;
    try {
      response = await upgrade(`${url}/?v=10&encoding=json`);
    } catch {
      console.warn("gateway_connect_failed");
      this.scheduleReconnect();
      return;
    }
    const socket = response.webSocket;
    if (!socket) {
      console.warn(`gateway_handshake_rejected status=${response.status}`);
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        const retryAfter = (seconds(response.headers.get("retry-after")) ?? 0) * 1000;
        this.scheduleReconnect(Math.max(retryAfter, this.backoff()));
      } else if (resuming) {
        // A resume host that refuses the upgrade cannot resume this session.
        this.resetSession();
        this.scheduleReconnect();
      } else {
        this.disable();
        await this.disableAfterFatal();
      }
      return;
    }
    socket.addEventListener("message", (event) => this.onMessage(socket, event.data));
    socket.addEventListener("close", (event) => this.onClose(socket, event.code));
    socket.addEventListener("error", () => {
      if (socket === this.socket) this.scheduleReconnect();
    });
    socket.accept();
    if (!this.enabled) {
      // Stopped while the upgrade was in flight.
      socket.close(1000, "stop");
      return;
    }
    this.socket = socket;
  }

  /** Discord's gateway URL, once the daily IDENTIFY budget allows another session. */
  private async identifyUrl() {
    const wait = this.identifyAfter - Date.now();
    if (wait > 0) {
      this.scheduleReconnect(wait);
      return null;
    }
    let info;
    try {
      info = await gatewayBot(this.env);
    } catch {
      console.warn("gateway_session_limit_unavailable");
      this.scheduleReconnect();
      return null;
    }
    const limit = info.session_start_limit;
    if (limit.remaining < 1) {
      // Exceeding the limit makes Discord reset the bot token.
      const delay = Math.max(limit.reset_after, this.backoff());
      this.identifyAfter = Date.now() + delay;
      console.error(`gateway_identify_budget_exhausted reset_after_s=${Math.trunc(delay / 1000)}`);
      this.scheduleReconnect(delay);
      return null;
    }
    return gatewayUrl(info.url);
  }

  private onMessage(socket: WebSocket, data: unknown) {
    if (socket !== this.socket) return;
    let payload;
    try {
      payload = JSON.parse(String(data));
    } catch {
      console.warn("gateway_payload_parse_failed");
      return;
    }
    if (payload.s != null) this.sequence = payload.s;
    switch (payload.op) {
      case 10: // Hello
        this.startHeartbeat(payload.d.heartbeat_interval);
        this.identifyOrResume();
        break;
      case 11: // Heartbeat ACK. Replays from a stale saved sequence are deduplicated anyway.
        this.heartbeatAcknowledged = true;
        if (this.sessionId && this.sequence !== this.savedSequence) this.background(this.saveSession());
        break;
      case 1: // Heartbeat request
        this.sendHeartbeat();
        break;
      case 9: // Invalid session: Discord asks for a random 1-5 s wait.
        if (!payload.d) this.resetSession();
        this.reconnect(Math.max(1000 + Math.random() * 4000, this.backoff()));
        break;
      case 7: // Reconnect request
        this.reconnect();
        break;
      case 0:
        this.onDispatch(payload.t, payload.d);
    }
  }

  private onDispatch(type: string, data: any) {
    switch (type) {
      case "READY":
        this.sessionId = data.session_id;
        this.resumeUrl = data.resume_gateway_url;
        this.botUserId = data.user.id;
        this.attempts = 0;
        this.background(this.saveSession());
        console.log("gateway_ready");
        break;
      case "RESUMED":
        this.attempts = 0;
        console.log("gateway_resumed");
        break;
      case "MESSAGE_CREATE":
        if (this.processed.has(data.id)) return;
        this.processed.add(data.id);
        if (this.processed.size > 2000) this.processed.delete(this.processed.values().next().value!);
        this.background(this.processMessage(data));
    }
  }

  // `processed:` markers dedupe events Discord replays after a resume.
  private async processMessage(message: any) {
    const key = `processed:${message.id}`;
    if ((await this.ctx.storage.get(key)) !== undefined) return;
    await this.ctx.storage.put(key, Date.now());
    await handleMessage(this.env, message, this.botUserId);
  }

  private onClose(socket: WebSocket, code: number) {
    if (socket !== this.socket) return;
    this.clearHeartbeat();
    this.socket = null;
    if (FATAL_CLOSE_CODES.has(code)) {
      console.error(`gateway_fatal_close code=${code}`);
      this.disable();
      this.background(this.disableAfterFatal());
      return;
    }
    console.warn(`gateway_closed code=${code}`);
    if (NON_RESUMABLE_CLOSE_CODES.has(code)) this.resetSession();
    this.scheduleReconnect();
  }

  // Stop rapid retries after a fatal Discord response; cron or an explicit start retries.
  private disable() {
    this.enabled = false;
    this.clearReconnect();
    this.resetSession();
  }

  private async disableAfterFatal() {
    await this.ctx.storage.delete("gatewayEnabled");
    await this.ctx.storage.deleteAlarm();
  }

  private identifyOrResume() {
    const token = this.env.DISCORD_BOT_TOKEN;
    if (this.sessionId && this.resumeUrl) {
      this.send({ op: 6, d: { token, session_id: this.sessionId, seq: this.sequence } });
    } else {
      const properties = { os: "linux", browser: "ragbot-worker", device: "ragbot-worker" };
      this.send({ op: 2, d: { token, intents: INTENTS, properties } });
    }
  }

  private startHeartbeat(interval: number) {
    this.clearHeartbeat();
    this.heartbeatAcknowledged = true;
    const tick = () => {
      // No ACK since the last beat means a zombie connection.
      if (!this.heartbeatAcknowledged) {
        console.warn("gateway_heartbeat_missed");
        this.reconnect();
        return;
      }
      this.sendHeartbeat();
      this.heartbeatTimer = setTimeout(tick, interval);
    };
    // Discord asks for the first heartbeat after a random fraction of the interval.
    this.heartbeatTimer = setTimeout(tick, interval * Math.random());
  }

  private sendHeartbeat() {
    this.heartbeatAcknowledged = false;
    this.send({ op: 1, d: this.sequence });
  }

  private send(payload: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(payload));
  }

  private closeSocket(code: number, reason: string) {
    this.clearHeartbeat();
    const socket = this.socket;
    this.socket = null; // Events from the discarded socket are ignored.
    if (socket && socket.readyState <= WebSocket.OPEN) socket.close(code, reason);
  }

  private clearHeartbeat() {
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private async saveSession() {
    if (!this.sessionId) {
      await this.ctx.storage.delete("gatewaySession");
      return;
    }
    this.savedSequence = this.sequence;
    const session = { sessionId: this.sessionId, resumeUrl: this.resumeUrl, sequence: this.sequence, botUserId: this.botUserId };
    await this.ctx.storage.put("gatewaySession", session);
  }

  private resetSession() {
    this.sequence = this.sessionId = this.resumeUrl = null;
    this.background(this.saveSession());
  }

  // Exponential reconnect delay from 1 s to 5 min, with jitter; READY or RESUMED resets it.
  private backoff() {
    this.attempts += 1;
    return Math.min(2 ** Math.min(this.attempts - 1, 9), 300) * 1000 + Math.random() * 1000;
  }

  private reconnect(delay?: number) {
    this.closeSocket(4000, "reconnect");
    this.scheduleReconnect(delay);
  }

  private scheduleReconnect(delay?: number) {
    if (!this.enabled || this.reconnectTimer !== null) return;
    delay ??= this.backoff();
    console.warn(`gateway_reconnect_scheduled attempt=${this.attempts} delay_s=${(delay / 1000).toFixed(1)}`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.closeSocket(4000, "reconnect");
      this.background(this.connectGateway());
    }, delay);
  }

  private background(task: Promise<unknown>) {
    task.catch(() => console.error("gateway_background_failed"));
  }
}

// Open the socket with a fetch upgrade so a refused handshake reports its HTTP status.
async function upgrade(url: string) {
  let timer = 0;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("gateway handshake timed out")), 15_000);
  });
  try {
    return await Promise.race([fetch(url.replace(/^wss:/, "https:"), { headers: { Upgrade: "websocket" } }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
