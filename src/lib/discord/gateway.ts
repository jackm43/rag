// Discord gateway protocol over a Workers WebSocket: handshake, heartbeat, identify or resume,
// backoff and close codes. The host owns persistence and dispatch through `GatewayHooks`.
import { getGatewayBot, seconds } from "./rest.ts";

// Opcode and intent names follow Oceanic's Constants (MIT, OceanicJS/Oceanic).
export const GatewayOPCodes = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

export const Intents = {
  GUILD_MESSAGES: 1 << 9,
  DIRECT_MESSAGES: 1 << 12,
  MESSAGE_CONTENT: 1 << 15,
} as const;

const DEFAULT_URL = "wss://gateway.discord.gg";
// Authentication, sharding, version and intent errors: stop rapid retries until the host restarts.
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
// The session is gone: reconnect with a fresh IDENTIFY instead of RESUME.
const NON_RESUMABLE_CLOSE_CODES = new Set([4003, 4007, 4009]);

export type Session = { sessionId: string; resumeUrl: string; sequence: number | null; botUserId: string | null };

export type GatewayHooks = {
  token: string;
  intents: number;
  /** Persist the resumable session, or clear it when given null. */
  saveSession(session: Session | null): Promise<void>;
  /** Every dispatch except READY and RESUMED, which the connection handles itself. */
  dispatch(type: string, data: any): void;
  /** A fatal close or refused handshake disabled the connection. */
  fatal(): Promise<void>;
  /** Failures of background work started by the connection. */
  background(task: Promise<unknown>): void;
};

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

export class GatewayConnection {
  enabled = false;
  botUserId: string | null = null;
  private socket: WebSocket | null = null;
  private heartbeatTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private connecting: Promise<void> = Promise.resolve();
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private sequence: number | null = null;
  private savedSequence: number | null = null;
  private heartbeatAcknowledged = true;
  private attempts = 0;
  private identifyAfter = 0;
  private readonly hooks: GatewayHooks;

  constructor(hooks: GatewayHooks) {
    this.hooks = hooks;
  }

  get connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  get resumable() {
    return Boolean(this.sessionId && this.resumeUrl);
  }

  get reconnectPending() {
    return this.reconnectTimer !== null;
  }

  restore(session: Session) {
    this.sessionId = session.sessionId;
    this.resumeUrl = session.resumeUrl;
    this.sequence = this.savedSequence = session.sequence;
    this.botUserId = session.botUserId;
  }

  /** Forget the backoff and IDENTIFY wait; Discord's IDENTIFY budget is still checked. */
  resetBackoff() {
    this.attempts = 0;
    this.identifyAfter = 0;
  }

  // Connection attempts run one at a time; each re-checks state, so queued calls are no-ops.
  connect() {
    const attempt = this.connecting.then(() => this.openSocket());
    this.connecting = attempt.catch(() => {});
    return attempt;
  }

  /** Close and stop retrying; the next connect sends a fresh IDENTIFY. */
  stop() {
    this.disable();
    this.closeSocket(1000, "stop");
  }

  private async openSocket() {
    if (!this.enabled || (this.socket && this.socket.readyState <= WebSocket.OPEN)) return;
    this.clearReconnect();
    this.closeSocket(4000, "reconnect");
    const resuming = this.resumable;
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
        await this.hooks.fatal();
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
      info = await getGatewayBot(this.hooks.token);
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
      case GatewayOPCodes.HELLO:
        this.startHeartbeat(payload.d.heartbeat_interval);
        this.identifyOrResume();
        break;
      case GatewayOPCodes.HEARTBEAT_ACK: // Replays from a stale saved sequence are the host's to dedupe.
        this.heartbeatAcknowledged = true;
        if (this.sessionId && this.sequence !== this.savedSequence) this.hooks.background(this.saveSession());
        break;
      case GatewayOPCodes.HEARTBEAT:
        this.sendHeartbeat();
        break;
      case GatewayOPCodes.INVALID_SESSION: // Discord asks for a random 1-5 s wait.
        if (!payload.d) this.resetSession();
        this.reconnect(Math.max(1000 + Math.random() * 4000, this.backoff()));
        break;
      case GatewayOPCodes.RECONNECT:
        this.reconnect();
        break;
      case GatewayOPCodes.DISPATCH:
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
        this.hooks.background(this.saveSession());
        console.log("gateway_ready");
        break;
      case "RESUMED":
        this.attempts = 0;
        console.log("gateway_resumed");
        break;
      default:
        this.hooks.dispatch(type, data);
    }
  }

  private onClose(socket: WebSocket, code: number) {
    if (socket !== this.socket) return;
    this.clearHeartbeat();
    this.socket = null;
    if (FATAL_CLOSE_CODES.has(code)) {
      console.error(`gateway_fatal_close code=${code}`);
      this.disable();
      this.hooks.background(this.hooks.fatal());
      return;
    }
    console.warn(`gateway_closed code=${code}`);
    if (NON_RESUMABLE_CLOSE_CODES.has(code)) this.resetSession();
    this.scheduleReconnect();
  }

  private disable() {
    this.enabled = false;
    this.clearReconnect();
    this.resetSession();
  }

  private identifyOrResume() {
    const token = this.hooks.token;
    if (this.resumable) {
      this.send({ op: GatewayOPCodes.RESUME, d: { token, session_id: this.sessionId, seq: this.sequence } });
    } else {
      const properties = { os: "linux", browser: "ragbot-worker", device: "ragbot-worker" };
      this.send({ op: GatewayOPCodes.IDENTIFY, d: { token, intents: this.hooks.intents, properties } });
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
    this.send({ op: GatewayOPCodes.HEARTBEAT, d: this.sequence });
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

  private saveSession() {
    if (!this.sessionId || !this.resumeUrl) return this.hooks.saveSession(null);
    this.savedSequence = this.sequence;
    return this.hooks.saveSession({
      sessionId: this.sessionId,
      resumeUrl: this.resumeUrl,
      sequence: this.sequence,
      botUserId: this.botUserId,
    });
  }

  private resetSession() {
    this.sequence = this.sessionId = this.resumeUrl = null;
    this.hooks.background(this.saveSession());
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
      this.hooks.background(this.connect());
    }, delay);
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
