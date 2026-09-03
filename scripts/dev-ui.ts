// Launches the local debugging UI (dev/ + wrangler.dev.jsonc). Local only —
// this never deploys anything.
//
//   pnpm run dev:ui
//
// Secrets are resolved automatically from 1Password: the bot's own .env plus
// .env.dev (which overrides it) list each variable as an `op://` reference, and
// this launcher resolves them with the 1Password SDK before starting wrangler, so
// the dev worker sees the real DISCORD_APPLICATION_ID, public key, etc. rather
// than unresolved references. Authentication, in order:
//   1. OP_SERVICE_ACCOUNT_TOKEN in the environment (service account);
//   2. the 1Password desktop app (biometrics), account from OP_ACCOUNT or the
//      default "my.1password.com";
//   3. the `op` CLI (`op read`), as a last resort.
// A variable already set in the shell to a non-`op://` value is used as-is.
//
// Resolved values reach the worker as `--var` bindings on the wrangler process
// (nothing is written to disk). CLOUDFLARE_API_TOKEN is also exported to
// wrangler itself so the Workers AI binding and any remote resource proxying
// are authenticated without a separate `wrangler login`.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

import { createClient, DesktopAuth } from "@1password/sdk";

const CONFIG = "wrangler.dev.jsonc";
// Later files override earlier ones.
const SECRETS_FILES = [".env", ".env.dev"];
const REQUIRED = new Set(["CF_AIG_TOKEN"]);
const INTEGRATION = { integrationName: "ragbot-dev-ui", integrationVersion: "v1.0.0" };

type SecretRef = { name: string; ref: string };

const parseSecretRefs = (paths: string[]): SecretRef[] => {
  const byName = new Map<string, SecretRef>();
  for (const path of paths) {
    if (!existsSync(path)) {
      continue;
    }
    for (const rawLine of readFileSync(path, "utf8").split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }
      const match = /^([A-Z0-9_]+)=["']?(op:\/\/[^"']+)["']?$/.exec(line);
      if (match) {
        byName.set(match[1], { name: match[1], ref: match[2] });
      }
    }
  }
  return [...byName.values()];
};

type Resolver = (ref: string) => Promise<string>;

const SDK_ATTEMPTS = 3;
const SDK_RETRY_DELAY_MS = 1500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Tries each SDK auth path in turn — service account (OP_SERVICE_ACCOUNT_TOKEN),
// then the desktop app — retrying transient transport errors ("error sending
// request" from the SDK's HTTP layer) before giving up on that path.
const sdkResolver = async (): Promise<Resolver | null> => {
  const paths: Array<{ label: string; auth: string | DesktopAuth }> = [];
  if (process.env.OP_SERVICE_ACCOUNT_TOKEN) {
    paths.push({ label: "service account", auth: process.env.OP_SERVICE_ACCOUNT_TOKEN });
  }
  paths.push({ label: "desktop app", auth: new DesktopAuth(process.env.OP_ACCOUNT ?? "my.1password.com") });

  for (const path of paths) {
    for (let attempt = 1; attempt <= SDK_ATTEMPTS; attempt += 1) {
      try {
        const client = await createClient({ auth: path.auth, ...INTEGRATION });
        console.log(`1Password: authenticated via ${path.label}.`);
        return (ref) => client.secrets.resolve(ref);
      } catch (error) {
        const message = describe(error);
        const transient = /sending request|timed out|connection|network|reqwest/i.test(message);
        console.warn(`1Password SDK (${path.label}, attempt ${attempt}/${SDK_ATTEMPTS}): ${message}`);
        if (!transient || attempt === SDK_ATTEMPTS) {
          break;
        }
        await sleep(SDK_RETRY_DELAY_MS * attempt);
      }
    }
  }
  console.warn(
    `1Password SDK unavailable on Node ${process.version}; falling back to the op CLI.` +
      (process.env.HTTPS_PROXY || process.env.https_proxy
        ? " (HTTPS_PROXY is set: Node's fetch ignores proxies, which can break the SDK while the CLI still works.)"
        : ""),
  );
  return null;
};

const cliResolver: Resolver = async (ref) => {
  const result = spawnSync("op", ["read", "--no-newline", ref], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`op read failed for ${ref}: ${result.stderr.trim()}`);
  }
  return result.stdout;
};

const resolveSecrets = async (refs: SecretRef[]): Promise<Record<string, string>> => {
  const resolved: Record<string, string> = {};
  const pending: SecretRef[] = [];
  for (const entry of refs) {
    const fromShell = process.env[entry.name];
    if (fromShell && !fromShell.startsWith("op://")) {
      resolved[entry.name] = fromShell;
    } else {
      pending.push(entry);
    }
  }
  if (pending.length === 0) {
    return resolved;
  }

  const resolve = (await sdkResolver()) ?? cliResolver;
  for (const entry of pending) {
    try {
      resolved[entry.name] = await resolve(entry.ref);
      console.log(`1Password: resolved ${entry.name}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (REQUIRED.has(entry.name)) {
        throw new Error(`could not resolve ${entry.name}: ${message}`);
      }
      console.warn(`1Password: could not resolve ${entry.name} (${message}); continuing without it.`);
    }
  }
  return resolved;
};

const main = async () => {
  const secrets = await resolveSecrets(parseSecretRefs(SECRETS_FILES));
  for (const name of REQUIRED) {
    if (!secrets[name]) {
      throw new Error(`${name} is required (add its op:// reference to ${SECRETS_FILES.at(-1)} or export it)`);
    }
  }
  if (!secrets.CLOUDFLARE_API_TOKEN) {
    console.warn("CLOUDFLARE_API_TOKEN unavailable: the production replay/config panels will be disabled.");
  }

  const childEnv = {
    ...process.env,
    // wrangler dev would otherwise load the bot's .env, whose unresolved op://
    // references would override the dev worker's vars (DISCORD_APPLICATION_ID
    // and friends). Secrets travel as --var instead.
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    ...(secrets.CLOUDFLARE_API_TOKEN ? { CLOUDFLARE_API_TOKEN: secrets.CLOUDFLARE_API_TOKEN } : {}),
  };

  console.log("Applying D1 migrations to the local database...");
  const migrate = spawnSync("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "ragbot", "--local", "-c", CONFIG], {
    stdio: "inherit",
    env: childEnv,
  });
  if (migrate.status !== 0) {
    process.exit(migrate.status ?? 1);
  }

  const varArgs = Object.entries(secrets).flatMap(([name, value]) => ["--var", `${name}:${value}`]);
  const extra = process.argv.slice(2);
  console.log("Starting the dev UI at http://localhost:8788 ...");
  const child = spawn("pnpm", ["exec", "wrangler", "dev", "-c", CONFIG, ...varArgs, ...extra], {
    stdio: "inherit",
    env: childEnv,
  });
  child.on("exit", (code) => process.exit(typeof code === "number" ? code : 0));
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal));
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
