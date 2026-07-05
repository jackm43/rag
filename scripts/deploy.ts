// Deploys the workers by discovering wrangler.jsonc configs under apps/ —
// no hand-maintained config-path list. Order still matters (a worker must
// exist before another binds it), so DEPLOY_ORDER pins the binding-safe
// sequence by worker name; a discovered worker missing from the list fails
// the deploy loudly instead of silently never deploying.
//
//   pnpm run deploy                 — the core set, in order
//   pnpm run deploy -- --only webhooks   — named workers only
//
// webhooks is excluded from the core set (see the README's one-time bootstrap
// checklist): it has bootstrap steps (queues) and deploys individually via
// --only.
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DEPLOY_ORDER = [
  // The auth worker (API Gateway) first: every public app binds it as AUTH.
  "ragbot-auth-worker",
  "ragbot-connectors-worker",
  "ragbot-responder-worker",
  // workflows before the gateway: the gateway binds workflows' InteractionSession
  // DO cross-script, so the defining worker must exist first.
  "ragbot-workflows-worker",
  "ragbot-worker", // gateway
  "ragbot-spend-worker",
];

const MANUAL_BOOTSTRAP = new Set(["ragbot-webhooks-worker"]);

const discover = (dir: string, found: Map<string, string>): void => {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) {
      continue;
    }
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      discover(path, found);
    } else if (entry === "wrangler.jsonc") {
      const name = readFileSync(path, "utf8").match(/"name"\s*:\s*"([^"]+)"/)?.[1];
      if (!name) {
        throw new Error(`No worker name in ${path}`);
      }
      if (found.has(name)) {
        throw new Error(`Duplicate worker name ${name}: ${found.get(name)} and ${path}`);
      }
      found.set(name, path);
    }
  }
};

const workers = new Map<string, string>();
discover("apps", workers);

const unknown = [...workers.keys()].filter(
  (name) => !DEPLOY_ORDER.includes(name) && !MANUAL_BOOTSTRAP.has(name),
);
if (unknown.length > 0) {
  throw new Error(
    `Workers discovered but not in DEPLOY_ORDER (add them, or to MANUAL_BOOTSTRAP): ${unknown.join(", ")}`,
  );
}

const onlyArg = process.argv.indexOf("--only");
const only = onlyArg === -1 ? null : new Set(process.argv[onlyArg + 1].split(","));

const matches = (name: string): boolean => {
  if (!only) {
    return DEPLOY_ORDER.includes(name);
  }
  // --only accepts full worker names or the short form (dev-proxy, spend, ...)
  return only.has(name) || only.has(name.replace(/^ragbot-/, "").replace(/-worker$/, "")) ||
    (name === "ragbot-worker" && only.has("gateway"));
};

const sequence = [...DEPLOY_ORDER, ...MANUAL_BOOTSTRAP].filter(
  (name) => workers.has(name) && matches(name),
);
if (sequence.length === 0) {
  throw new Error("Nothing to deploy — check --only names");
}
for (const name of sequence) {
  const config = workers.get(name)!;
  console.log(`\n=== deploying ${name} (${config}) ===`);
  execSync(`wrangler deploy -c ${JSON.stringify(config)}`, { stdio: "inherit" });
}
