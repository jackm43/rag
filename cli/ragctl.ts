#!/usr/bin/env -S npx tsx
import { readFileSync } from "node:fs";
import process from "node:process";

import {
  decodeClaims,
  fetchToken,
  login,
  readCachedToken,
  tokenIsExpired,
} from "./access";
import { configPath, resolveConfig, tokenPath, type ConfigOverrides } from "./config";
import { discover } from "./discover";
import { createDevProxyClient, type CommandRequest, type GithubApiRequest } from "../packages/devproxy-client/index";

// ragctl — a local CLI for the ragbot dev-proxy. Runs on a laptop (Node, not
// workerd) and drives the deployed dev-proxy: it acquires a Cloudflare Access
// token via `cloudflared` and issues typed commands through
// packages/devproxy-client. The dev-proxy now also requires a Better Auth
// (Discord) session, which is established in the browser; a non-browser caller
// must supply that session cookie via RAGCTL_SESSION_COOKIE (see `cmd` below).
// See the README "Local development with ragctl" section for the operator flow.

// --- tiny argv parser -------------------------------------------------------
// Supports `--flag value`, `--flag=value`, repeated flags (collected), and bare
// `--flag` booleans. Values starting with `--` are not supported as flag values
// (fine for this tool's inputs).
type Args = {
  positionals: string[];
  flags: Map<string, string[]>;
};

const parseArgs = (argv: string[]): Args => {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  const push = (key: string, value: string): void => {
    const list = flags.get(key) ?? [];
    list.push(value);
    flags.set(key, list);
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        push(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        push(body, next);
        index += 1;
      } else {
        push(body, "true");
      }
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
};

const flag = (args: Args, name: string): string | undefined => {
  const list = args.flags.get(name);
  return list && list.length > 0 ? list[list.length - 1] : undefined;
};

const all = (args: Args, name: string): string[] => args.flags.get(name) ?? [];

const has = (args: Args, name: string): boolean => args.flags.has(name);

// The command-name shape the dev-proxy enforces (openapi.yaml / worker zod).
const COMMAND_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

// Global flags that override config regardless of subcommand.
const overridesFrom = (args: Args): ConfigOverrides => {
  const overrides: ConfigOverrides = {};
  const baseUrl = flag(args, "base-url");
  const accessUrl = flag(args, "access-url");
  if (baseUrl !== undefined) {
    overrides.baseUrl = baseUrl;
  }
  if (accessUrl !== undefined) {
    overrides.accessUrl = accessUrl;
  }
  return overrides;
};

const out = (line = ""): void => {
  process.stdout.write(`${line}\n`);
};

const HELP = `ragctl — local client for the ragbot dev-proxy

Usage: ragctl <command> [options]

Commands:
  login [--refresh]         Cloudflare Access SSO via cloudflared; cache the token
                            (--refresh re-fetches without the browser login)
  whoami                    Decode the cached Access token's claims
  discover                  List the dev-proxy operations from the OpenAPI spec
  cmd <name> [--opt k=v ...] [--channel <id>] [--json]
                            Run a slash command through the dev-proxy (typed call)
  gh <route> [--installation <id>] [--param k=v ...] [--body <json>] [--json]
                            Call GitHub through the GitHub App connector.
                            Route is Octokit-style, e.g. "GET /repos/{owner}/{repo}/issues"
  config                    Show resolved config and where each value came from

Global options:
  --base-url <url>          Override the dev-proxy base URL
  --access-url <url>        Override the Cloudflare Access application URL
  -h, --help                Show this help

A browser-established Better Auth (Discord) session is also required for \`cmd\`;
supply it to a non-browser caller via RAGCTL_SESSION_COOKIE.

Config precedence: flag > env (RAGCTL_BASE_URL / RAGCTL_ACCESS_URL) > config file > default.
Files live under $RAGCTL_HOME or ${"${XDG_CONFIG_HOME:-~/.config}"}/ragctl.`;

const runLogin = (args: Args): number => {
  const { config } = resolveConfig(overridesFrom(args));
  const cached = has(args, "refresh") ? fetchToken(config.accessUrl) : login(config.accessUrl);
  const claims = decodeClaims(cached.token);
  out(`Cached Access token for ${cached.appUrl}`);
  out(`subject: ${claims.sub ?? "(none)"}${claims.email ? ` <${claims.email}>` : ""}`);
  if (cached.exp !== null) {
    out(`expires: ${new Date(cached.exp * 1000).toISOString()}`);
  }
  out(`token cached at ${tokenPath()}`);
  return 0;
};

const runWhoami = (): number => {
  const cached = readCachedToken();
  if (!cached) {
    out("No cached Access token — run `ragctl login` first.");
    return 1;
  }
  const claims = decodeClaims(cached.token);
  out(`app:     ${cached.appUrl}`);
  out(`subject: ${claims.sub ?? "(none)"}`);
  out(`email:   ${claims.email ?? "(none)"}`);
  out(`issuer:  ${claims.iss ?? "(none)"}`);
  out(`audience: ${JSON.stringify(claims.aud ?? null)}`);
  if (cached.exp !== null) {
    const expired = tokenIsExpired(cached);
    out(`expires: ${new Date(cached.exp * 1000).toISOString()}${expired ? " (EXPIRED — run `ragctl login`)" : ""}`);
  }
  return 0;
};

const runDiscover = (): number => {
  const { serverUrl, operations } = discover();
  if (serverUrl) {
    out(`server: ${serverUrl}`);
    out("");
  }
  for (const operation of operations) {
    const id = operation.operationId ? ` [${operation.operationId}]` : "";
    const security = operation.security.length > 0 ? ` (auth: ${operation.security.join(" + ")})` : "";
    out(`${operation.method} ${operation.path}${id}${security}`);
    if (operation.summary) {
      out(`  ${operation.summary}`);
    }
  }
  return 0;
};

// Human-readable hints for the fail-closed statuses the worker returns. The
// worker never discloses which gate refused, so these are guidance, not claims.
const STATUS_HINT: Record<number, string> = {
  400: "malformed request (check the command name / options or GitHub route / params)",
  401: "Access token or Better Auth session rejected — run `ragctl login` and set RAGCTL_SESSION_COOKIE from a browser session",
  403: "the acting Discord subject is not allowed by the gateway (DEV_PROXY_ALLOWED_SUBJECTS)",
  502: "upstream gateway error",
};

const keyValueFlags = (args: Args, name: string): Record<string, string> =>
  Object.fromEntries(
    all(args, name).map((entry) => {
      const eq = entry.indexOf("=");
      if (eq <= 0) {
        throw new Error(`--${name} expects name=value, got "${entry}"`);
      }
      return [entry.slice(0, eq), entry.slice(eq + 1)];
    }),
  );

const scalar = (value: string): string | number | boolean => {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return value;
};

const authenticatedClient = (args: Args): ReturnType<typeof createDevProxyClient> => {
  const { config } = resolveConfig(overridesFrom(args));

  const cached = readCachedToken();
  if (!cached) {
    process.stderr.write("ragctl: no cached Access token — run `ragctl login` (sending anyway; the worker will deny).\n");
  } else if (tokenIsExpired(cached)) {
    process.stderr.write("ragctl: cached Access token is expired — run `ragctl login` (sending anyway).\n");
  }

  // The dev-proxy also requires a Better Auth (Discord) session. A browser sends
  // its cookie automatically; a CLI caller must pass it via RAGCTL_SESSION_COOKIE
  // (copy the `better-auth.session_token` cookie from a logged-in browser).
  const sessionCookie = process.env.RAGCTL_SESSION_COOKIE;
  if (!sessionCookie) {
    process.stderr.write("ragctl: RAGCTL_SESSION_COOKIE is unset — the worker will deny without a Better Auth session (sending anyway).\n");
  }

  return createDevProxyClient({
    baseUrl: config.baseUrl,
    ...(cached ? { accessToken: () => cached.token } : {}),
    ...(sessionCookie ? { sessionCookie: () => sessionCookie } : {}),
  });
};

const printResponse = (response: { status: number; body: unknown; contentType?: string; json?: boolean }, json: boolean): number => {
  const body =
    typeof response.body === "string" && response.body.length > 2000
      ? `${response.body.slice(0, 2000)}\n\n... truncated ${response.body.length - 2000} chars ...`
      : response.body;
  if (json) {
    out(JSON.stringify({ status: response.status, contentType: response.contentType, body }, null, 2));
  } else {
    out(`HTTP ${response.status}`);
    if (response.contentType && !response.json) {
      out(`(non-JSON response: ${response.contentType})`);
    }
    const hint = STATUS_HINT[response.status];
    if (hint) {
      out(`(${hint})`);
    }
    out(typeof body === "string" ? body : JSON.stringify(body, null, 2));
  }
  return response.status >= 200 && response.status < 300 && response.json !== false ? 0 : 1;
};

const runCmd = async (args: Args): Promise<number> => {
  const command = args.positionals[1];
  if (!command) {
    out("Usage: ragctl cmd <name> [--opt name=value ...] [--channel <id>] [--json]");
    return 1;
  }
  if (!COMMAND_PATTERN.test(command)) {
    out(`Invalid command name "${command}" — must match ${COMMAND_PATTERN}`);
    return 1;
  }

  const options = Object.entries(keyValueFlags(args, "opt")).map(([name, value]) => ({ name, value }));

  const request: CommandRequest = { command };
  const channelId = flag(args, "channel");
  if (channelId !== undefined) {
    request.channelId = channelId;
  }
  if (options.length > 0) {
    request.options = options;
  }

  return printResponse(await authenticatedClient(args).command(request), has(args, "json"));
};

const runGh = async (args: Args): Promise<number> => {
  const installationId = flag(args, "installation") ?? flag(args, "installation-id") ?? "144201662";
  const first = args.positionals[1];
  const second = args.positionals[2];
  if (!first) {
    out('Usage: ragctl gh "GET /repos/{owner}/{repo}/issues" --param owner=jsmunro --param repo=rag [--installation <id>] [--json]');
    return 1;
  }

  const route = second && /^[A-Z]+$/.test(first) ? `${first} ${second}` : first;
  const paramsJson = flag(args, "params-json");
  const params =
    paramsJson !== undefined
      ? JSON.parse(paramsJson)
      : Object.fromEntries(Object.entries(keyValueFlags(args, "param")).map(([key, value]) => [key, scalar(value)]));
  const body = flag(args, "body-file") !== undefined ? readFileSync(flag(args, "body-file")!, "utf8") : flag(args, "body");
  const request: GithubApiRequest = {
    installationId,
    route,
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(body !== undefined ? { body } : {}),
  };
  return printResponse(await authenticatedClient(args).github(request), has(args, "json"));
};

const runConfig = (args: Args): number => {
  const { config, sources } = resolveConfig(overridesFrom(args));
  out(`baseUrl:    ${config.baseUrl}  (${sources.baseUrl})`);
  out(`accessUrl:  ${config.accessUrl}  (${sources.accessUrl})`);
  out("");
  out(`config file: ${configPath()}`);
  out("precedence:  flag > env > config file > default");
  return 0;
};

const main = async (): Promise<number> => {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positionals[0];

  if (command === undefined || command === "help" || has(args, "help") || has(args, "h")) {
    out(HELP);
    return command === undefined ? 1 : 0;
  }

  switch (command) {
    case "login":
      return runLogin(args);
    case "whoami":
      return runWhoami();
    case "discover":
      return runDiscover();
    case "cmd":
      return runCmd(args);
    case "gh":
      return runGh(args);
    case "config":
      return runConfig(args);
    default:
      out(`Unknown command: ${command}`);
      out("Run `ragctl help` for usage.");
      return 1;
  }
};

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`ragctl: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
