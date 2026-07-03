#!/usr/bin/env -S npx tsx
import process from "node:process";

import { configPath, keyPath, resolveConfig, type ConfigOverrides } from "./config";
import { generateKey, showKey } from "./keys";

// ragctl — a local CLI for the ragbot dev-proxy. Runs on a laptop (Node, not
// workerd) and drives the deployed dev-proxy: it manages a local DPoP keypair,
// acquires a Cloudflare Access token via `cloudflared`, and issues typed
// commands through packages/devproxy-client. See the README "Local development
// with ragctl" section for the operator flow.

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

const has = (args: Args, name: string): boolean => args.flags.has(name);

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
  keys generate [--force]   Generate + persist a local DPoP ES256 keypair
  keys show                 Show the public JWK + jkt thumbprint (never the private key)
  config                    Show resolved config and where each value came from

Global options:
  --base-url <url>          Override the dev-proxy base URL
  --access-url <url>        Override the Cloudflare Access application URL
  -h, --help                Show this help

Config precedence: flag > env (RAGCTL_BASE_URL / RAGCTL_ACCESS_URL) > config file > default.
Files live under $RAGCTL_HOME or ${"${XDG_CONFIG_HOME:-~/.config}"}/ragctl.`;

const runKeys = async (args: Args): Promise<number> => {
  const sub = args.positionals[1];
  if (sub === "generate") {
    const result = await generateKey(has(args, "force"));
    if (!result.created) {
      out(`A DPoP key already exists at ${result.path} (jkt ${result.jkt}).`);
      out("Re-run with --force to replace it (this rotates the jkt).");
      return 1;
    }
    out(`Generated DPoP keypair at ${result.path}`);
    out(`jkt: ${result.jkt}`);
    return 0;
  }
  if (sub === "show") {
    const info = showKey();
    out(`path:      ${info.path}`);
    out(`created:   ${info.createdAt}`);
    out(`jkt:       ${info.jkt}`);
    out(`publicJwk: ${JSON.stringify(info.publicJwk)}`);
    return 0;
  }
  out("Usage: ragctl keys <generate|show>");
  return 1;
};

const runConfig = (args: Args): number => {
  const { config, sources } = resolveConfig(overridesFrom(args));
  out(`baseUrl:    ${config.baseUrl}  (${sources.baseUrl})`);
  out(`accessUrl:  ${config.accessUrl}  (${sources.accessUrl})`);
  out("");
  out(`config file: ${configPath()}`);
  out(`dpop key:    ${keyPath()}`);
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
    case "keys":
      return runKeys(args);
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
