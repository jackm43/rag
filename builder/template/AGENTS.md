# Building a Ragbot app

You are building a web app that members of a Discord server asked for. It can be
anything that runs in a browser: a one-off site, a multiplayer game, a 3D demo,
a tool. Build what they asked for, make it delightful, and make it work.

## Platform

- The app is served over HTTPS at `/<app-name>/` on an origin shared with the
  server's other apps. The host puts Discord login in front of every request
  and only admits members of the server. Never build login, accounts,
  passwords or invite codes.
- Because of that path prefix, every URL must be relative: `./logo.png`, never
  `/logo.png`. Vite is already configured with `base: "./"`. Use hash-based
  routing (`#/scores`) if the app needs several screens. Prefix any
  `localStorage` keys with something unique to this app.
- Stack: Vite with plain JavaScript modules. Add npm packages when they help
  (`npm install three`, `pixi.js`, `phaser`, `tone`, `matter-js`, `react`, ...).
  The npm registry is the only network access you have while building.
- Everything is bundled. At runtime the page may only load files from its own
  origin: CDNs, web fonts, analytics and third-party APIs are blocked by the
  content security policy. Import libraries from npm, use system fonts or
  bundle fonts (for example `@fontsource/*`), and put images, audio, 3D models
  and other static files in `public/` or import them from `src/`.
- `npm run build` must write `dist/index.html`. Output limits: 400 files, 10 MiB
  per file and 25 MiB total. Keep file names to letters, digits, `-`, `_`, `.`.
- Share and persist data with the room API below. When the rules must be
  enforced or something must stay hidden from players, add `server/room.js`.
- Players will open the app from Discord, often on phones. Design for touch and
  small screens as well as desktop.

## Identity and realtime rooms

`src/ragbot.js` is the host SDK. Read it; do not change its protocol.

```js
import { getMe, joinRoom } from "./ragbot.js";

const me = await getMe(); // { id, name, avatar } for the signed-in member

const room = joinRoom("lobby", {
  onState(state, info) {},     // shared JSON state changed (by anyone)
  onMessage(data, from) {},    // another connection called room.send(data)
  onPeers(peers) {},           // [{ sid, id, name, avatar }] currently connected
  onStatus(status) {},         // "connecting" | "open" | "closed"
});
room.send({ type: "move", x: 1 });                 // to everyone else, or to server/room.js
await room.setState((s) => ({ ...s, score: 1 }));  // atomic update, retried on conflict
room.state; room.peers; room.me; room.server; room.leave();
```

- A room is a named channel (`[A-Za-z0-9_-]{1,64}`) shared by everyone using
  this app. Use one room for the whole app, or one per game/lobby.
- Shared state is JSON up to 128 KiB, stored durably and delivered to everyone
  who joins later. Messages are up to 64 KiB and are not stored.
- Without `server/room.js` the host only relays and stores, so clients agree on
  the rules themselves (for example, the peer with the smallest `sid` acts as
  host), and everyone can read everything.
- A peer is one connection. The same member in two tabs is two peers with the
  same `id`. Handle peers leaving mid-game and the room being empty.
- Plain HTTP also works, relative to the app: `GET ./_api/rooms/NAME` returns
  `{version, state, peers}` and `PUT ./_api/rooms/NAME` with `{version, state}`
  writes (409 on a stale version). `GET ./_api/me` returns the member.

## Server logic (optional)

Add `server/room.js` when players must not be able to see or bend something: a
hidden word, private hands, fair dice, turn order, a countdown. The host runs it
for every room of this app, isolated (no network, no storage of its own, a few
milliseconds per event), and it becomes the authority for those rooms:

```js
// server/room.js: export any of these; nothing else.
export function join(room, peer) {}           // a connection joined
export function leave(room, peer) {}          // a connection left
export function message(room, peer, data) {}  // a client called room.send(data)
export function tick(room) {}                 // the time asked for with room.wakeIn(ms)
```

- `room.state`: the public shared state. Assign to it to change it; every client
  receives it through `onState`. Clients can no longer call `setState`.
- `room.secret`: a private object only this code sees, kept per room. Put hidden
  answers, decks and hands here, never in `room.state`.
- `room.send(sid, data)` messages one connection; `room.broadcast(data)` messages
  everyone. Clients receive these through `onMessage` with `from.sid === "server"`.
- `room.peers`, `room.name`, `room.now`; `room.wakeIn(ms)` calls `tick` later
  (100 ms to 1 hour; the last call wins; ticks stop when nobody is connected).
- Handlers may import from `src/` and npm; the host bundles them. Keep state and
  secret JSON-serialisable. `Math.random()` and `crypto` are available.
- Test it like any module: call the handlers with a plain object, for example
  `{ name: "t", now: 0, peers: [], state: null, secret: {}, sent: [], send(sid, data) { this.sent.push({ sid, data }); }, broadcast(data) { this.sent.push({ data }); }, wakeIn() {} }`.

## Quality bar

- Finish the whole experience: title, instructions, controls, win/lose/empty/
  loading/error states, reconnect handling. No placeholder text or TODOs.
- Give it a distinctive look that fits the request; avoid generic defaults.
  Keep it accessible: semantic HTML, labels, keyboard support, good contrast.
- Keep logic that can be tested in plain modules, and cover it with
  `node --test` tests in `test/`. `npm test` must pass.
- Before you finish, run `npm run build` and `npm test` and fix every failure.
- Never include secrets or tracking. Do not edit `src/ragbot.js` or this file.

When you are done, reply with two or three sentences for the Discord server:
what you built and how to use it. The host posts that reply with the app link.
