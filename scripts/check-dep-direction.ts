// Enforces the workspace dependency rules that keep the repo's shape honest:
//   1. packages/* (shared) never import an app package (apps/* are deployed
//      workers, not libraries).
//   2. An app never imports another app — all shared code lives in packages/*,
//      so a top-level worker-app depends only on packages, never on a sibling
//      app. (Intra-app imports within a multi-worker app like platform are fine.)
//   3. The workspace import graph is acyclic.
// Run via `pnpm run check`. Root-owned code (test/, scripts/) is exempt from
// 1-2 (tests exercise worker internals directly).
import fs from "node:fs";
import path from "node:path";

const workspaceRoots: Array<[string, string]> = [];
for (const top of ["packages", "apps"]) {
  for (const name of fs.readdirSync(top)) {
    const dir = path.join(top, name);
    const manifest = path.join(dir, "package.json");
    if (!fs.existsSync(manifest)) continue;
    // Use the real package name, not the directory name — they can differ (e.g.
    // apps dir names can differ from package names).
    const pkg = JSON.parse(fs.readFileSync(manifest, "utf8")).name as string;
    workspaceRoots.push([dir, pkg]);
  }
}

// App packages: every workspace root under apps/. Nothing shared imports these,
// and no app imports another.
const APP_PKGS = new Set(
  workspaceRoots.filter(([dir]) => dir.startsWith("apps/")).map(([, pkg]) => pkg),
);

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
      if (!isShared && APP_PKGS.has(target) && target !== pkg) {
        failures.push(`${file}: app imports another app (${spec}); shared code belongs in packages/`);
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
