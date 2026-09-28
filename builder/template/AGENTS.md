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
- There is no server-side code. Persist and share data with the room API below.
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
room.send({ type: "move", x: 1 });                 // relay to everyone else, not stored
await room.setState((s) => ({ ...s, score: 1 }));  // atomic update, retried on conflict
room.state; room.peers; room.me; room.leave();
```

- A room is a named channel (`[A-Za-z0-9_-]{1,64}`) shared by everyone using
  this app. Use one room for the whole app, or one per game/lobby.
- Shared state is JSON up to 128 KiB, stored durably and delivered to everyone
  who joins later. Messages are up to 64 KiB and are not stored.
- The server relays and stores data but runs no game logic, so the clients must
  agree on the rules. A common pattern: the connected peer with the smallest
  `sid` acts as the host and writes authoritative state. Everyone can read
  everything, so secrets such as a hidden answer are visible to a determined
  player; that is acceptable for friends, but say so in your summary.
- A peer is one connection. The same member in two tabs is two peers with the
  same `id`. Handle peers leaving mid-game and the room being empty.
- Plain HTTP also works, relative to the app: `GET ./_api/rooms/NAME` returns
  `{version, state, peers}` and `PUT ./_api/rooms/NAME` with `{version, state}`
  writes (409 on a stale version). `GET ./_api/me` returns the member.

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
