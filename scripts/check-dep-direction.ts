// Enforces the workspace dependency rules that keep the repo's shape honest:
//   1. packages/* (shared) never import app packages (@rag/bot|connectors|platform).
//   2. Apps may import another app only through its published surfaces
//      (lib/, contracts/, devproxy-client/) — never another app's workers/.
//   3. The workspace import graph is acyclic.
// Run via `pnpm run check`. Root-owned code (test/, scripts/, cli/) is exempt
// from 1-2 (tests exercise worker internals directly).
import fs from "node:fs";
import path from "node:path";

const APP_PKGS = new Set(["@rag/bot", "@rag/connectors", "@rag/platform"]);
const CROSS_APP_SURFACES = /^@rag\/(bot|connectors|platform)\/(lib|contracts|devproxy-client)(\/|$)/;

const workspaceRoots: Array<[string, string]> = [];
for (const top of ["packages", "apps"]) {
  for (const name of fs.readdirSync(top)) {
    const dir = path.join(top, name);
    if (fs.existsSync(path.join(dir, "package.json"))) workspaceRoots.push([dir, `@rag/${name}`]);
  }
}

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const p = path.join(dir, entry);
    if (fs.statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(entry)) yield p;
  }
}

const failures: string[] = [];
const graph = new Map<string, Set<string>>();

for (const [dir, pkg] of workspaceRoots) {
  const edges = new Set<string>();
  graph.set(pkg, edges);
  const isShared = dir.startsWith("packages/");
  for (const file of walk(dir)) {
    const src = fs.readFileSync(file, "utf8");
    for (const match of src.matchAll(/(?:from|import)\s*\(?\s*["'](@rag\/[^"']+)["']/g)) {
      const spec = match[1];
      const target = spec.split("/").slice(0, 2).join("/");
      if (target !== pkg) edges.add(target);
      if (isShared && APP_PKGS.has(target)) {
        failures.push(`${file}: shared package imports app code (${spec})`);
      }
      if (!isShared && APP_PKGS.has(target) && target !== pkg && !CROSS_APP_SURFACES.test(spec)) {
        failures.push(`${file}: cross-app import outside lib/contracts surfaces (${spec})`);
      }
    }
  }
}

// cycle detection over the workspace graph
const visiting = new Set<string>();
const done = new Set<string>();
const visit = (pkg: string, trail: string[]): void => {
  if (done.has(pkg)) return;
  if (visiting.has(pkg)) {
    failures.push(`dependency cycle: ${[...trail, pkg].join(" -> ")}`);
    return;
  }
  visiting.add(pkg);
  for (const dep of graph.get(pkg) ?? []) visit(dep, [...trail, pkg]);
  visiting.delete(pkg);
  done.add(pkg);
};
for (const pkg of graph.keys()) visit(pkg, []);

if (failures.length > 0) {
  console.error("Dependency direction check failed:");
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`Dependency direction check passed (${workspaceRoots.length} workspace packages, acyclic).`);
