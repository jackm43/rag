import { spawn } from "node:child_process";
import { Console } from "node:console";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";

const logger = new Console({ stdout: process.stderr, stderr: process.stderr });

const baseUrl = (process.env.RAGBOT_URL ?? "https://ragbot-worker.jsmunro.workers.dev").replace(
  /\/$/,
  "",
);

const CALLBACK_PORT = 8976;
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`;
const TOKEN_FILE = join(homedir(), ".config", "ragbot", "tokens.json");
const EXPIRY_SKEW_SECONDS = 30;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const usage = `usage: ragbot <command>

commands:
  config list                 show all config keys with values and defaults
  config get <key>            show one config value
  config set <key> <value>    override a config value
  config unset <key>          reset a config value to its default
  db <sql> [param ...]        run a SQL statement against D1
  interactions [limit]        show recent AI interactions
  ragboard                    show the rag leaderboard
  gateway health              show Discord gateway connection state
  gateway start               enable and connect the Discord gateway
  whoami                      show the identity the admin API sees
  login                       force a fresh browser login
  logout                      drop cached tokens for this worker

environment:
  RAGBOT_URL                  worker base URL (default ${baseUrl})

authentication: OIDC authorization code flow with PKCE against the Cloudflare
Access for SaaS application (discovered from ${baseUrl}/oauth/config). Tokens
are cached in ${TOKEN_FILE} and refreshed automatically.`;

const fail = (message: string): never => {
  logger.error(message);
  process.exit(1);
};

type OidcConfig = {
  issuer: string;
  client_id: string;
  authorization_endpoint: string;
  token_endpoint: string;
};

type TokenSet = {
  access_token: string;
  refresh_token: string | null;
  expires_at: number;
};

type TokenStore = Record<string, TokenSet>;

const readTokenStore = (): TokenStore => {
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as TokenStore;
  } catch {
    return {};
  }
};

const writeTokenStore = (store: TokenStore) => {
  mkdirSync(dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(TOKEN_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
  chmodSync(TOKEN_FILE, 0o600);
};

const saveTokens = (tokens: TokenSet | null) => {
  const store = readTokenStore();
  if (tokens) {
    store[baseUrl] = tokens;
  } else {
    delete store[baseUrl];
  }
  writeTokenStore(store);
};

let oidcConfig: OidcConfig | null = null;

const getOidcConfig = async (): Promise<OidcConfig> => {
  if (oidcConfig) {
    return oidcConfig;
  }
  const response = await fetch(`${baseUrl}/oauth/config`);
  if (!response.ok) {
    fail(`could not load OIDC configuration from ${baseUrl}/oauth/config (${response.status}); is ACCESS_OIDC_CLIENT_ID configured on the worker?`);
  }
  oidcConfig = (await response.json()) as OidcConfig;
  return oidcConfig;
};

const base64url = (buffer: Buffer) =>
  buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const openBrowser = (url: string) => {
  const candidates = process.platform === "darwin" ? ["open"] : ["xdg-open", "wslview", "sensible-browser"];
  for (const command of candidates) {
    const child = spawn(command, [url], { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  }
};

const waitForCallback = (expectedState: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? "/", REDIRECT_URI);
      if (url.pathname !== "/callback") {
        response.writeHead(404).end();
        return;
      }

      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const ok = !error && code && state === expectedState;

      response.writeHead(ok ? 200 : 400, { "content-type": "text/html" });
      response.end(
        ok
          ? "<html><body>Login complete. You can close this tab.</body></html>"
          : "<html><body>Login failed. Return to the terminal.</body></html>",
      );
      server.close();
      clearTimeout(timeout);

      if (!ok) {
        reject(new Error(error ?? "missing code or state mismatch in OIDC callback"));
        return;
      }
      resolve(code);
    });

    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("timed out waiting for browser login"));
    }, LOGIN_TIMEOUT_MS);

    server.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server.listen(CALLBACK_PORT, "127.0.0.1");
  });

const postTokenRequest = async (form: Record<string, string>): Promise<TokenSet | null> => {
  const config = await getOidcConfig();
  const response = await fetch(config.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...form, client_id: config.client_id }).toString(),
  });

  const body = (await response.json().catch(() => null)) as
    | {
      access_token?: string;
      id_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
    }
    | null;
  const accessToken = body?.access_token ?? body?.id_token;
  if (!response.ok || !accessToken) {
    logger.debug(`token request failed (${response.status}): ${JSON.stringify(body)}`);
    return null;
  }

  return {
    access_token: accessToken,
    refresh_token: body?.refresh_token ?? null,
    expires_at: Math.floor(Date.now() / 1000) + (body?.expires_in ?? 300),
  };
};

const browserLogin = async (): Promise<TokenSet> => {
  const config = await getOidcConfig();
  const codeVerifier = base64url(randomBytes(48));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
  const state = base64url(randomBytes(24));

  const authorizationUrl = new URL(config.authorization_endpoint);
  authorizationUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: config.client_id,
    redirect_uri: REDIRECT_URI,
    scope: "openid email profile",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }).toString();

  logger.info(`opening browser for login; if nothing happens, visit:\n${authorizationUrl}`);
  const callback = waitForCallback(state);
  openBrowser(authorizationUrl.toString());
  const code = await callback;

  const tokens = await postTokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier,
  });
  if (!tokens) {
    fail("authorization code exchange failed");
  }
  saveTokens(tokens);
  return tokens as TokenSet;
};

const refreshTokens = async (refreshToken: string): Promise<TokenSet | null> => {
  const tokens = await postTokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (tokens) {
    saveTokens(tokens);
  }
  return tokens;
};

const getBearerToken = async (forceReauth = false): Promise<string> => {
  if (!forceReauth) {
    const cached = readTokenStore()[baseUrl];
    if (cached) {
      if (cached.expires_at - EXPIRY_SKEW_SECONDS > Math.floor(Date.now() / 1000)) {
        return cached.access_token;
      }
      if (cached.refresh_token) {
        const refreshed = await refreshTokens(cached.refresh_token);
        if (refreshed) {
          return refreshed.access_token;
        }
      }
      logger.info("cached tokens expired, starting browser login");
    }
  }
  return (await browserLogin()).access_token;
};

const request = async (method: string, path: string, body?: unknown) => {
  const send = async (bearer: string) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

  let response = await send(await getBearerToken());
  if (response.status === 401) {
    response = await send(await getBearerToken(true));
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }

  if (!response.ok) {
    fail(`${method} ${path} failed (${response.status}): ${JSON.stringify(parsed)}`);
  }
  return parsed;
};

const print = (value: unknown) => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const main = async () => {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "config") {
    const [action, key, value] = rest;
    if (action === "list") {
      print(await request("GET", "/admin/config"));
      return;
    }
    if (action === "get" && key) {
      const result = (await request("GET", "/admin/config")) as {
        config: Record<string, unknown>;
      };
      if (!(key in result.config)) {
        fail(`unknown config key: ${key}`);
      }
      print({ [key]: result.config[key] });
      return;
    }
    if (action === "set" && key && value !== undefined) {
      print(await request("PUT", "/admin/config", { key, value }));
      return;
    }
    if (action === "unset" && key) {
      print(await request("DELETE", `/admin/config/${key}`));
      return;
    }
    fail(usage);
  }

  if (command === "db") {
    const [sql, ...params] = rest;
    if (!sql) {
      fail(usage);
    }
    print(await request("POST", "/admin/db", { sql, params }));
    return;
  }

  if (command === "interactions") {
    const limit = rest[0] ?? "20";
    print(await request("GET", `/admin/interactions?limit=${encodeURIComponent(limit)}`));
    return;
  }

  if (command === "ragboard") {
    print(
      await request("POST", "/admin/db", {
        sql: "SELECT ragged_user_id, ragged_username, rag_count, updated_at FROM rag_totals ORDER BY rag_count DESC, ragged_user_id ASC LIMIT 25",
        params: [],
      }),
    );
    return;
  }

  if (command === "gateway") {
    const [action] = rest;
    if (action === "health") {
      print(await request("GET", "/admin/gateway/health"));
      return;
    }
    if (action === "start") {
      print(await request("POST", "/admin/gateway/start"));
      return;
    }
    fail(usage);
  }

  if (command === "whoami") {
    print(await request("GET", "/admin/whoami"));
    return;
  }

  if (command === "login") {
    await browserLogin();
    print(await request("GET", "/admin/whoami"));
    return;
  }

  if (command === "logout") {
    saveTokens(null);
    print({ ok: true, cleared: baseUrl });
    return;
  }

  fail(usage);
};

await main();
