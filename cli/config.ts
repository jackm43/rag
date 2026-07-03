import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

// ragctl configuration + on-disk layout. Everything the CLI persists (the local
// DPoP key, the cached Access token, the config file) lives under one home
// directory so it is easy to find, back up, and delete. The home is, in order:
//   1. $RAGCTL_HOME (explicit override)
//   2. $XDG_CONFIG_HOME/ragctl
//   3. ~/.config/ragctl
// The directory is created 0700 and the secret-bearing files 0600 (see keys.ts /
// access.ts), so no other local user can read the private key or token.

// The deployed dev-proxy hostname (openapi.yaml `servers` / the worker route).
export const DEFAULT_BASE_URL = "https://ragbot-dev.jsmunro.me";

export const ragctlHome = (): string => {
  const override = process.env.RAGCTL_HOME;
  if (override && override.length > 0) {
    return override;
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "ragctl");
};

export const configPath = (): string => join(ragctlHome(), "config.json");
export const keyPath = (): string => join(ragctlHome(), "dpop-key.json");
export const tokenPath = (): string => join(ragctlHome(), "access-token.json");

// Create the home directory (idempotent) with owner-only permissions.
export const ensureHome = (): string => {
  const dir = ragctlHome();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
};

export type Config = {
  // Base URL of the dev-proxy the typed client calls.
  baseUrl: string;
  // The Cloudflare Access application URL `cloudflared` authenticates against.
  // Defaults to baseUrl — the Access application sits in front of the dev-proxy.
  accessUrl: string;
};

export type ConfigOverrides = Partial<Config>;

// Where a resolved value came from, so `ragctl config` can show precedence.
export type ConfigSource = "flag" | "env" | "file" | "default";

const readFileConfig = (): Partial<Config> => {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8")) as Partial<Config>;
  } catch {
    // Missing or malformed file is not an error: fall back to env + defaults.
    return {};
  }
};

export type ResolvedConfig = {
  config: Config;
  sources: Record<keyof Config, ConfigSource>;
};

// Resolve config with a fixed precedence: flag > env > config file > default.
export const resolveConfig = (overrides: ConfigOverrides = {}): ResolvedConfig => {
  const file = readFileConfig();

  const pick = (
    flag: string | undefined,
    env: string | undefined,
    fromFile: string | undefined,
    fallback: string,
  ): { value: string; source: ConfigSource } => {
    if (flag !== undefined) {
      return { value: flag, source: "flag" };
    }
    if (env !== undefined && env.length > 0) {
      return { value: env, source: "env" };
    }
    if (fromFile !== undefined && fromFile.length > 0) {
      return { value: fromFile, source: "file" };
    }
    return { value: fallback, source: "default" };
  };

  const baseUrl = pick(overrides.baseUrl, process.env.RAGCTL_BASE_URL, file.baseUrl, DEFAULT_BASE_URL);
  const accessUrl = pick(overrides.accessUrl, process.env.RAGCTL_ACCESS_URL, file.accessUrl, baseUrl.value);

  return {
    config: { baseUrl: baseUrl.value, accessUrl: accessUrl.value },
    sources: { baseUrl: baseUrl.source, accessUrl: accessUrl.source },
  };
};

export const configFileExists = (): boolean => existsSync(configPath());
