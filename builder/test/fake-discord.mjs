// Test-only stand-in for the Discord API used by the builder's login flow.
// Authorization codes are "code-<user>"; alice and bob are guild members,
// mallory is not. Membership can be revoked to test re-verification. With a
// TLS key pair it also serves the consent page browsers are sent to; which
// user is "logged in to Discord" comes from that browser's own cookie.
import http from "node:http";
import https from "node:https";

export const GUILD = "457689460096630794";
export const USERS = {
  alice: { id: "200000000000000001", username: "alice", global_name: "Alice" },
  bob: { id: "200000000000000002", username: "bob", global_name: "Bob" },
  mallory: {
    id: "200000000000000003",
    username: "mallory",
    global_name: "Mallory",
  },
};

function authorize(request, response, { clientId, redirectUri }) {
  const url = new URL(request.url, "https://discord.com");
  const user = /(?:^|; )fake_discord_user=(\w+)/.exec(
    request.headers.cookie ?? "",
  )?.[1];
  const scopes = (url.searchParams.get("scope") ?? "")
    .split(" ")
    .sort()
    .join(" ");
  if (
    url.pathname !== "/oauth2/authorize" ||
    url.searchParams.get("client_id") !== clientId ||
    url.searchParams.get("redirect_uri") !== redirectUri ||
    url.searchParams.get("response_type") !== "code" ||
    scopes !== "guilds.members.read identify" ||
    !USERS[user]
  ) {
    response.writeHead(400).end("bad authorize request");
    return;
  }
  const target = new URL(redirectUri);
  target.search = new URLSearchParams({
    code: `code-${user}`,
    state: url.searchParams.get("state") ?? "",
  }).toString();
  response.writeHead(302, { location: target.href }).end();
}

export function start(
  port,
  { clientId, clientSecret, redirectUri, tls, consentPort },
) {
  const members = new Set(["alice", "bob"]);
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url, "http://discord");
    calls.push({ method: request.method, path: url.pathname });
    const send = (status, value) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const bearer = (request.headers.authorization ?? "").replace(
      /^Bearer token-/,
      "",
    );
    const user = USERS[bearer];
    if (request.method === "POST" && url.pathname === "/api/v10/oauth2/token") {
      const form = new URLSearchParams(body);
      const name = (form.get("code") ?? "").replace(/^code-/, "");
      if (
        form.get("client_id") !== clientId ||
        form.get("client_secret") !== clientSecret ||
        form.get("redirect_uri") !== redirectUri ||
        form.get("grant_type") !== "authorization_code" ||
        !USERS[name]
      )
        return send(400, { error: "invalid_grant" });
      return send(200, {
        access_token: `token-${name}`,
        token_type: "Bearer",
        expires_in: 604800,
        scope: "identify guilds.members.read",
      });
    }
    if (request.method === "GET" && url.pathname === "/api/v10/users/@me")
      return user ? send(200, user) : send(401, {});
    const member = url.pathname.match(
      /^\/api\/v10\/users\/@me\/guilds\/(\d+)\/member$/,
    );
    if (request.method === "GET" && member) {
      if (!user) return send(401, {});
      if (member[1] !== GUILD || !members.has(bearer))
        return send(404, { code: 10004 });
      return send(200, {
        user,
        nick: null,
        avatar: null,
        roles: [],
        pending: false,
      });
    }
    return send(404, {});
  });
  const consent =
    tls &&
    https.createServer(tls, (request, response) =>
      authorize(request, response, { clientId, redirectUri }),
    );
  if (consent) consent.listen(consentPort, "127.0.0.1");
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () =>
      resolve({
        calls,
        revoke: (name) => members.delete(name),
        close: () => {
          server.close();
          consent?.close();
        },
      }),
    ),
  );
}
