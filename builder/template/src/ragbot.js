// Ragbot host SDK: the signed-in Discord member and realtime rooms.
// The host that serves this app implements the protocol below and has already
// verified that the viewer is a member of the Discord server. Do not edit.

// Apps live at /<app-name>/ on a shared origin; the API is under that prefix.
const BASE = location.pathname.match(/^\/[^/]+\//)?.[0] ?? "/";

export async function getMe() {
  const response = await fetch(`${BASE}_api/me`, {
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error("Not signed in");
  return response.json();
}

export function joinRoom(name, handlers = {}) {
  return new Room(name, handlers);
}

export class Room {
  constructor(name, handlers = {}) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name))
      throw new Error("Invalid room name");
    this.name = name;
    this.handlers = handlers;
    this.me = null;
    this.peers = [];
    this.state = null;
    this.version = 0;
    this.status = "connecting";
    // True when the app has server/room.js: it owns the state and gets messages.
    this.server = false;
    this.pending = new Map();
    this.retry = 0;
    this.closed = false;
    this.connect();
  }

  connect() {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(
      `${scheme}://${location.host}${BASE}_api/rooms/${this.name}`,
    );
    this.socket = socket;
    this.setStatus("connecting");
    socket.onmessage = (event) => this.receive(JSON.parse(event.data));
    socket.onclose = () => {
      if (this.socket !== socket) return;
      clearInterval(this.ping);
      for (const { reject } of this.pending.values())
        reject(new Error("Disconnected"));
      this.pending.clear();
      this.setStatus("closed");
      if (this.closed) return;
      const delay = Math.min(10000, 500 * 2 ** this.retry++);
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }

  receive(message) {
    switch (message.t) {
      case "welcome":
        this.retry = 0;
        this.me = message.you;
        this.server = Boolean(message.server);
        this.peers = message.peers;
        this.applyState(message, null);
        this.setStatus("open");
        clearInterval(this.ping);
        this.ping = setInterval(() => this.raw({ t: "ping" }), 20000);
        this.handlers.onPeers?.(this.peers);
        break;
      case "join":
        this.peers = [
          ...this.peers.filter((p) => p.sid !== message.peer.sid),
          message.peer,
        ];
        this.handlers.onPeers?.(this.peers);
        break;
      case "leave":
        this.peers = this.peers.filter((p) => p.sid !== message.peer.sid);
        this.handlers.onPeers?.(this.peers);
        break;
      case "message":
        this.handlers.onMessage?.(message.data, message.from);
        break;
      case "state": {
        const waiting = this.pending.get(message.ref);
        this.pending.delete(message.ref);
        if (message.version >= this.version)
          this.applyState(message, message.by ?? null);
        if (waiting)
          message.conflict ? waiting.retry() : waiting.resolve(this.state);
        break;
      }
      case "error":
        this.pending.get(message.ref)?.reject(new Error(message.error));
        this.pending.delete(message.ref);
        break;
    }
  }

  applyState(message, by) {
    const changed = message.version !== this.version || this.state === null;
    this.version = message.version;
    this.state = message.state;
    if (changed)
      this.handlers.onState?.(this.state, { version: this.version, by });
  }

  setStatus(status) {
    this.status = status;
    this.handlers.onStatus?.(status);
  }

  raw(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  /**
   * Send data to every other connection (or one peer by sid), not stored. When
   * the app has server/room.js, it goes to the server's `message` handler instead.
   */
  send(data, to) {
    return this.raw({ t: "send", data, ...(to ? { to } : {}) });
  }

  /**
   * Replace the shared state. With a function, the update is applied to the
   * latest state and retried if someone else wrote first.
   */
  setState(update) {
    if (this.server)
      return Promise.reject(new Error("State is controlled by server/room.js"));
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const attempt = () => {
        if (++attempts > 8)
          return reject(new Error("Too many conflicting updates"));
        const ref = Math.random().toString(36).slice(2);
        const functional = typeof update === "function";
        const next = functional ? update(structuredClone(this.state)) : update;
        this.pending.set(ref, { resolve, reject, retry: attempt });
        const message = {
          t: "set",
          ref,
          state: next,
          ...(functional ? { version: this.version } : {}),
        };
        if (!this.raw(message)) {
          this.pending.delete(ref);
          reject(new Error("Not connected"));
        }
      };
      attempt();
    });
  }

  leave() {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.ping);
    this.socket?.close();
  }
}
